import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";
import {
  MISTRAL_URL,
  MODEL_TENNESSEE,
  MODEL_JUSTICE,
  DEFAULT_PORT,
  TEMPERATURE,
  MAX_HISTORY,
  MAX_BODY_SIZE,
  MAX_MESSAGE_CHARS,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
  PORT_RETRY_MAX,
} from "./config/server.js";
import { buildSystemPrompt, buildJusticeSystemPrompt } from "./config/system-prompt.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadKnowledge(file) {
  try {
    return readFileSync(path.join(__dirname, file), "utf8");
  } catch {
    console.warn(`  ⚠️  ${file} introuvable — la base correspondante sera vide.`);
    return "";
  }
}

const app = express();
const PORT = process.env.PORT || DEFAULT_PORT;
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

// Registre des modèles GRuth. Chaque mode a sa propre base de connaissances, son prompt
// système et son modèle Mistral : Tennessee privilégie la rapidité, Justice la
// profondeur d'analyse (voir config/server.js). L'identifiant 'model' est envoyé par le client.
const GRUTH_MODELS = {
  tennessee: {
    mistralModel: MODEL_TENNESSEE,
    systemPrompt: buildSystemPrompt(loadKnowledge("knowledge.md")),
  },
  justice: {
    mistralModel: MODEL_JUSTICE,
    systemPrompt: buildJusticeSystemPrompt(loadKnowledge("knowledge-justice.md")),
  },
};
const DEFAULT_GRUTH_MODEL = "tennessee";

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      // upgrade-insecure-requests est retiré : cette directive casse les ressources
      // (CSS, JS, fonts) sur un serveur HTTP local en forçant le navigateur à les
      // charger en HTTPS — ce qui échoue sans certificat TLS.
      upgradeInsecureRequests: null,
    },
  },
}));
// Rate limit limité à l'API : appliqué aux fichiers statiques, il bloquait des modules JS
// (une page = ~7 requêtes) dès 2-3 rechargements par minute, ce qui cassait tout le front.
app.use("/api/", rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de requêtes. Réessaie dans une minute." },
}));
// Si le corps JSON dépasse MAX_BODY_SIZE, express.json lève une erreur 413 (gérée ci-dessous)
app.use(express.json({ limit: MAX_BODY_SIZE }));

// Corps trop volumineux (au-delà de MAX_BODY_SIZE) : réponse claire au lieu d'une 500
app.use((err, _req, res, next) => {
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "Message trop volumineux." });
  }
  next(err);
});
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    models: { tennessee: MODEL_TENNESSEE, justice: MODEL_JUSTICE },
    configured: Boolean(MISTRAL_API_KEY),
  });
});

app.post("/api/chat", async (req, res) => {
  if (!MISTRAL_API_KEY) {
    return res.status(500).json({
      error: "Clé API Mistral manquante. Renseigne MISTRAL_API_KEY dans le fichier .env.",
    });
  }

  const { messages, model } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Le champ 'messages' est requis." });
  }

  // Sélection du modèle GRuth (Tennessee par défaut). On rejette un id inconnu plutôt que
  // de retomber silencieusement sur le défaut.
  const modelId = typeof model === "string" && model ? model : DEFAULT_GRUTH_MODEL;
  const selected = GRUTH_MODELS[modelId];
  if (!selected) {
    return res.status(400).json({ error: "Modèle inconnu." });
  }

  // Garde-fou anti-vidage de tokens : on rejette toute requête contenant un message
  // utilisateur trop long, avant même de relayer quoi que ce soit à l'API Mistral.
  // NB : la limite ne s'applique qu'aux messages 'user' — les réponses de l'assistant
  // peuvent légitimement dépasser MAX_MESSAGE_CHARS.
  const tooLong = messages.some(
    (m) =>
      m &&
      m.role === "user" &&
      typeof m.content === "string" &&
      m.content.length > MAX_MESSAGE_CHARS,
  );
  if (tooLong) {
    return res.status(400).json({
      error: `Message trop long (max ${MAX_MESSAGE_CHARS} caractères).`,
    });
  }

  // Le prompt système est injecté côté serveur — l'utilisateur ne peut pas le remplacer
  const payload = {
    model: selected.mistralModel,
    stream: true,
    temperature: TEMPERATURE,
    messages: [
      { role: "system", content: selected.systemPrompt },
      ...messages
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-MAX_HISTORY),
    ],
  };

  try {
    const upstream = await fetch(MISTRAL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MISTRAL_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => "");
      return res.status(502).json({
        error: "Erreur du service Mistral.",
        status: upstream.status,
        detail: detail.slice(0, 500),
      });
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();

    req.on("close", () => reader.cancel().catch(() => {}));

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
    res.end();
  } catch (err) {
    console.error("Erreur /api/chat:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Erreur interne du serveur." });
    } else {
      res.end();
    }
  }
});

function start(port, attemptsLeft = PORT_RETRY_MAX) {
  const server = app.listen(port, () => {
    console.log(`\n  GRuth — serveur démarré sur http://localhost:${port}`);
    console.log(`  Modèles Mistral : Tennessee=${MODEL_TENNESSEE} · Justice=${MODEL_JUSTICE}`);
    console.log(`  Clé API configurée : ${MISTRAL_API_KEY ? "oui" : "NON (voir .env)"}\n`);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
      console.warn(`  ⚠️  Le port ${port} est occupé, tentative sur ${port + 1}…`);
      start(port + 1, attemptsLeft - 1);
    } else if (err.code === "EADDRINUSE") {
      console.error(`\n  ✖ Impossible de trouver un port libre à partir de ${PORT}.`);
      console.error(`    Libère le port ou définis un autre PORT dans le fichier .env.\n`);
      process.exit(1);
    } else {
      console.error("  ✖ Erreur serveur :", err);
      process.exit(1);
    }
  });
}

start(Number(PORT));
