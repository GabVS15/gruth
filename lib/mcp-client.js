// Client MCP minimal (JSON-RPC sur HTTP « streamable ») — sans dépendance externe.
// Utilisé pour interroger le serveur des Codes législatifs : les outils qu'il expose sont
// transmis à Mistral, qui décide quand les appeler.

const PROTOCOL_VERSION = "2025-06-18";

export function createMcpClient(url, { timeoutMs, maxResultChars }) {
  let sessionId = null;
  let nextId = 1;

  async function post(body) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    sessionId = res.headers.get("mcp-session-id") || sessionId;
    return res;
  }

  // Requête JSON-RPC : la réponse peut arriver en JSON simple ou en flux SSE
  async function rpc(method, params) {
    const id = nextId++;
    const res = await post({ jsonrpc: "2.0", id, method, params });
    if (!res.ok) throw new Error(`MCP ${method} : HTTP ${res.status}`);

    const text = await res.text();
    let message;
    if ((res.headers.get("content-type") || "").includes("text/event-stream")) {
      message = text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => JSON.parse(l.slice(5)))
        .find((m) => m.id === id);
    } else {
      message = JSON.parse(text);
    }

    if (!message) throw new Error(`MCP ${method} : réponse vide`);
    if (message.error) throw new Error(`MCP ${method} : ${message.error.message}`);
    return message.result;
  }

  async function connect() {
    const result = await rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "gruth", version: "1.0.0" },
    });
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {});
    return result;
  }

  async function listTools() {
    const { tools } = await rpc("tools/list", {});
    return tools;
  }

  // Renvoie le texte de l'outil (erreurs métier comprises, pour que le modèle puisse
  // réessayer autrement) ; lève une exception seulement si le serveur est injoignable.
  async function callTool(name, args) {
    const result = await rpc("tools/call", { name, arguments: args });
    const text = (result.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    const output = result.isError ? `Erreur de l'outil : ${text}` : text || "(aucun résultat)";
    return output.length > maxResultChars ? output.slice(0, maxResultChars) + "\n[…tronqué]" : output;
  }

  return { connect, listTools, callTool };
}
