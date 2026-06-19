// Constantes côté serveur — modifier ici sans toucher à la logique de server.js

export const MISTRAL_URL     = "https://api.mistral.ai/v1/chat/completions";
export const DEFAULT_MODEL   = "mistral-large-latest";
export const DEFAULT_PORT    = 3000;
export const TEMPERATURE     = 0.4;
// Nombre de tours de conversation transmis à l'API par requête
export const MAX_HISTORY     = 20;
export const MAX_BODY_SIZE   = "1mb";
// Tentatives sur des ports successifs si le port cible est occupé
export const PORT_RETRY_MAX  = 10;
