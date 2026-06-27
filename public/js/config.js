// Constantes côté client — modifier ici sans toucher à la logique de app.js

export const STORAGE_KEY        = "gruth.conversations";
export const TITLE_MAX_LENGTH   = 38;
export const TEXTAREA_MAX_HEIGHT = 200;
// Longueur max d'un message (doit rester alignée avec MAX_MESSAGE_CHARS côté serveur)
export const MESSAGE_MAX_CHARS  = 2000;

// Modèles GRuth proposés dans le sélecteur (les id doivent correspondre à GRUTH_MODELS côté serveur)
export const DEFAULT_MODEL_ID = "tennessee";
export const MODELS = {
  tennessee: { name: "Tennessee", desc: "Assistant général de l'État du Tennessee" },
  justice:   { name: "Justice",   desc: "Spécialisé droit & justice, pour les avocats" },
};
export const API_ENDPOINT       = "/api/chat";
export const FALLBACK_ANSWER    = "Je n'ai pas pu générer de réponse. Réessayez.";
export const ONBOARDING_KEY     = "gruth.onboarding.done";

// Icône poubelle de l'historique
export const ICON_DELETE =
  `<svg viewBox="0 0 24 24" width="16" height="16">` +
  `<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7" ` +
  `fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>` +
  `</svg>`;

// Tri-étoile GRuth : trois étoiles asymétriques en blanc, positionnées via transform SVG
export const ICON_ASSISTANT_AVATAR =
  `<svg viewBox="0 0 100 100" fill="#fff" aria-hidden="true">` +
  `<path transform="translate(35 34) rotate(-10) scale(25)" d="M0 -1L0.2234 -0.3074L0.9511 -0.309L0.3614 0.1174L0.5878 0.809L0 0.38L-0.5878 0.809L-0.3614 0.1174L-0.9511 -0.309L-0.2234 -0.3074Z"/>` +
  `<path transform="translate(70 50) rotate(20) scale(22)" d="M0 -1L0.2234 -0.3074L0.9511 -0.309L0.3614 0.1174L0.5878 0.809L0 0.38L-0.5878 0.809L-0.3614 0.1174L-0.9511 -0.309L-0.2234 -0.3074Z"/>` +
  `<path transform="translate(46 73) rotate(8) scale(24)" d="M0 -1L0.2234 -0.3074L0.9511 -0.309L0.3614 0.1174L0.5878 0.809L0 0.38L-0.5878 0.809L-0.3614 0.1174L-0.9511 -0.309L-0.2234 -0.3074Z"/>` +
  `</svg>`;
