// Constantes côté serveur — modifier ici sans toucher à la logique de server.js

export const MISTRAL_URL     = "https://api.mistral.ai/v1/chat/completions";
export const DEFAULT_MODEL   = "mistral-large-latest";
// Modèle Mistral par mode GRuth : Tennessee privilégie la rapidité (small), Justice la
// profondeur d'analyse pour les avocats (large).
export const MODEL_TENNESSEE = "mistral-small-latest";
export const MODEL_JUSTICE   = "mistral-large-latest";
export const DEFAULT_PORT    = 3000;
export const TEMPERATURE     = 0.4;
// Nombre de tours de conversation transmis à l'API par requête
export const MAX_HISTORY     = 20;
// Taille max du corps JSON accepté (protège contre les requêtes géantes / vidage de tokens)
export const MAX_BODY_SIZE   = "100kb";
// Longueur max d'un message utilisateur (en caractères) — au-delà : requête rejetée
export const MAX_MESSAGE_CHARS = 2000;
// Anti-spam : nombre max de requêtes par IP sur la fenêtre de temps
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX        = 20;
// Tentatives sur des ports successifs si le port cible est occupé
export const PORT_RETRY_MAX  = 10;
