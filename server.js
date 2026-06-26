import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";
import {
  MISTRAL_URL,
  DEFAULT_MODEL,
  DEFAULT_PORT,
  TEMPERATURE,
  MAX_HISTORY,
  MAX_BODY_SIZE,
  MAX_MESSAGE_CHARS,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
  PORT_RETRY_MAX,
} from "./config/server.js";
import { buildSystemPrompt } from "./config/system-prompt.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let knowledge = "";
try {
  knowledge = readFileSync(path.join(__dirname, "knowledge.md"), "utf8");
} catch {
  console.warn("  ⚠️  knowledge.md introuvable — GRuth fonctionnera sans base de connaissances RP.");
}

const app = express();
const PORT = process.env.PORT || DEFAULT_PORT;
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const MISTRAL_MODEL = process.env.MISTRAL_MODEL || DEFAULT_MODEL;
const SYSTEM_PROMPT = buildSystemPrompt(knowledge);

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
app.use(rateLimit({
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
  res.json({ ok: true, model: MISTRAL_MODEL, configured: Boolean(MISTRAL_API_KEY) });
});

app.post("/api/chat", async (req, res) => {
  if (!MISTRAL_API_KEY) {
    return res.status(500).json({
      error: "Clé API Mistral manquante. Renseigne MISTRAL_API_KEY dans le fichier .env.",
    });
  }

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "Le champ 'messages' est requis." });
  }

  // Garde-fou anti-vidage de tokens : on rejette toute requête contenant un message
  // utilisateur trop long, avant même de relayer quoi que ce soit à l'API Mistral.
  const tooLong = messages.some(
    (m) => m && typeof m.content === "string" && m.content.length > MAX_MESSAGE_CHARS,
  );
  if (tooLong) {
    return res.status(400).json({
      error: `Message trop long (max ${MAX_MESSAGE_CHARS} caractères).`,
    });
  }

  // Le prompt système est injecté côté serveur — l'utilisateur ne peut pas le remplacer
  const payload = {
    model: MISTRAL_MODEL,
    stream: true,
    temperature: TEMPERATURE,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
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
    console.log(`  Modèle Mistral : ${MISTRAL_MODEL}`);
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
