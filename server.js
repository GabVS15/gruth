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
  MCP_CODES_URL,
  MCP_TIMEOUT_MS,
  MCP_MAX_RESULT_CHARS,
  MCP_MAX_TOOL_ROUNDS,
} from "./config/server.js";
import { buildSystemPrompt, buildJusticeSystemPrompt, buildCodesSection } from "./config/system-prompt.js";
import { createMcpClient } from "./lib/mcp-client.js";

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
// Le prompt est complété à chaque requête par la section des Codes (selon leur disponibilité).
const KNOWLEDGE_TENNESSEE = loadKnowledge("knowledge.md");
const KNOWLEDGE_JUSTICE = loadKnowledge("knowledge-justice.md");
const GRUTH_MODELS = {
  tennessee: {
    mistralModel: MODEL_TENNESSEE,
    buildPrompt: (codes) => buildSystemPrompt(KNOWLEDGE_TENNESSEE, codes),
  },
  justice: {
    mistralModel: MODEL_JUSTICE,
    buildPrompt: (codes) => buildJusticeSystemPrompt(KNOWLEDGE_JUSTICE, codes),
  },
};

// Codes législatifs (serveur MCP) : outils transmis à Mistral pour qu'il lise lui-même les
// textes de loi. Chargés au premier besoin ; en cas d'échec, nouvel essai après un délai
// pour ne pas faire attendre chaque requête pendant une panne.
const CODES_RETRY_MS = 60_000;
const codesMcp = createMcpClient(MCP_CODES_URL, {
  timeoutMs: MCP_TIMEOUT_MS,
  maxResultChars: MCP_MAX_RESULT_CHARS,
});
let codesPromise = null;
let codesFailedAt = 0;

function getCodes() {
  if (!codesPromise && Date.now() - codesFailedAt < CODES_RETRY_MS) return Promise.resolve(null);
  codesPromise ??= (async () => {
    await codesMcp.connect();
    const tools = await codesMcp.listTools();
    return {
      names: new Set(tools.map((t) => t.name)),
      tools: tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      })),
      codesList: await codesMcp.callTool("lister_codes", {}),
    };
  })().catch((err) => {
    console.warn(`  ⚠️  Codes législatifs (MCP) indisponibles : ${err.message}`);
    codesPromise = null;
    codesFailedAt = Date.now();
    return null;
  });
  return codesPromise;
}

// Exécute un appel d'outil demandé par le modèle. Renvoie toujours du texte : en cas
// d'erreur, le modèle est prévenu et peut réessayer autrement ou signaler l'indisponibilité.
async function runCodesTool(codes, call) {
  const name = call.function.name;
  if (!codes.names.has(name)) return `Outil inconnu : ${name}.`;
  let args;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    return "Arguments invalides : un objet JSON est attendu.";
  }
  console.log(`  🔎 ${name} ${JSON.stringify(args)}`);
  try {
    return await codesMcp.callTool(name, args);
  } catch (err) {
    return `Service des Codes momentanément indisponible (${err.message}).`;
  }
}

// Appelle Mistral en streaming : relaie le texte au fil de l'eau via onText et renvoie les
// appels d'outils éventuellement demandés par le modèle.
async function streamMistral(payload, signal, onText) {
  const upstream = await fetch(MISTRAL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${MISTRAL_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ ...payload, stream: true }),
    signal,
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    throw Object.assign(new Error("Erreur du service Mistral."), {
      upstreamStatus: upstream.status,
      detail: detail.slice(0, 500),
    });
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  const toolCalls = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") continue;
      let delta;
      try {
        delta = JSON.parse(data).choices?.[0]?.delta;
      } catch {
        continue;
      }
      if (!delta) continue;

      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        onText(delta.content);
      }
      // Les appels d'outils peuvent arriver en plusieurs fragments : on les recompose par index
      for (const tc of delta.tool_calls || []) {
        const slot = (toolCalls[tc.index ?? toolCalls.length] ??= {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.function.name += tc.function.name;
        const args = tc.function?.arguments;
        if (args) slot.function.arguments += typeof args === "string" ? args : JSON.stringify(args);
      }
    }
  }

  return { text, toolCalls: toolCalls.filter(Boolean) };
}
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
    codes: Boolean(codesPromise),
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

  const codes = await getCodes();

  // Le prompt système est injecté côté serveur — l'utilisateur ne peut pas le remplacer
  const conversation = [
    { role: "system", content: selected.buildPrompt(buildCodesSection(codes?.codesList ?? null)) },
    ...messages
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-MAX_HISTORY),
  ];

  // Client parti : on interrompt les appels en cours
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  // Le flux renvoyé au client reprend le format SSE de Mistral (choices[0].delta.content)
  const openStream = () => {
    if (res.headersSent) return;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
  };
  const sendText = (content) => {
    openStream();
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
  };

  try {
    // Boucle d'outils : tant que le modèle demande à consulter les Codes, on exécute ses
    // appels et on lui renvoie les résultats. Au dernier tour, les outils restent déclarés
    // (l'historique en contient) mais le modèle est forcé à répondre.
    for (let round = 0; ; round++) {
      const { text, toolCalls } = await streamMistral(
        {
          model: selected.mistralModel,
          temperature: TEMPERATURE,
          messages: conversation,
          ...(codes && {
            tools: codes.tools,
            tool_choice: round < MCP_MAX_TOOL_ROUNDS ? "auto" : "none",
          }),
        },
        abort.signal,
        sendText,
      );
      if (toolCalls.length === 0) break;

      conversation.push({ role: "assistant", content: text, tool_calls: toolCalls });
      for (const call of toolCalls) {
        conversation.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: await runCodesTool(codes, call),
        });
      }
    }
    openStream();
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    if (abort.signal.aborted) return;
    if (err.upstreamStatus) {
      if (!res.headersSent) {
        return res.status(502).json({ error: err.message, status: err.upstreamStatus, detail: err.detail });
      }
      sendText("\n\n⚠️ Erreur du service Mistral.");
      return res.end();
    }
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
    getCodes().then((codes) => {
      if (codes) console.log(`  Codes législatifs (MCP) connectés : ${codes.names.size} outils\n`);
    });
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
