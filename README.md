# GRuth — Assistant conversationnel de l'État du Tennessee

Interface web type Claude / Gemini, propulsée par **Mistral AI**, pour un assistant
gouvernemental de démonstration baptisé **GRuth**.

- 🎨 Interface inspirée de Claude / Gemini (barre latérale, historique, streaming token par token)
- 🔒 Clé API gérée **côté serveur** — jamais exposée au navigateur
- 🗂️ Historique des conversations stocké **localement** dans le navigateur (`localStorage`)
- 🇺🇸 Branding institutionnel « État du Tennessee » avec mise en avant de la confidentialité

## Prérequis

- Node.js 18+
- Une clé API Mistral : https://console.mistral.ai/

## Installation

```bash
npm install
cp .env.example .env
# puis ouvre .env et colle ta clé MISTRAL_API_KEY
```

## Démarrage

```bash
npm start        # http://localhost:3000
# ou en mode rechargement auto :
npm run dev
```

## Architecture

| Fichier            | Rôle                                                            |
|--------------------|-----------------------------------------------------------------|
| `server.js`        | Serveur Express, proxy SSE vers l'API Mistral, consigne système |
| `public/index.html`| Structure de l'interface                                        |
| `public/styles.css`| Style (couleurs du Tennessee : rouge `#c8102e`, bleu `#0a2a66`) |
| `public/app.js`    | Logique du chat, streaming, historique, rendu Markdown          |

## Note importante

Ceci est un **prototype**. Les mentions « sécurisé » et « confidentiel » décrivent
des choix techniques (clé API côté serveur, historique local) et **ne constituent pas
une certification officielle**. Avant tout usage présenté comme officiel, faites valider
le service par les autorités compétentes de l'État du Tennessee et remplacez les mentions
de conformité par les textes officiels exacts.
