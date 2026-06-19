// Rendu Markdown minimaliste : gras, italique, code inline, blocs ```, listes, titres, liens.
// L'input est entièrement échappé avant toute transformation pour éviter les injections XSS.
export function renderMarkdown(text) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Les blocs ``` sont extraits avant l'échappement pour ne pas encoder le code source.
  // Le marqueur \0 est un sentinel sûr : il ne peut pas apparaître dans du texte normal,
  // contrairement à un nombre entouré d'espaces (ex. "5 000 $") qui serait pris à tort
  // pour un marqueur lors de la réinjection.
  const blocks = [];
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
    blocks.push(`<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`);
    return `\0${blocks.length - 1}\0`;
  });

  text = esc(text);
  text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>'
  );

  const lines = text.split("\n");
  let html = "";
  let inList = false;
  let listTag = "ul";

  for (const line of lines) {
    const hr      = line.match(/^\s*([-*_])\1{2,}\s*$/);
    const heading = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/);
    const ul      = line.match(/^\s*[-*]\s+(.*)/);
    const ol      = line.match(/^\s*\d+\.\s+(.*)/);

    if (hr) {
      if (inList) { html += `</${listTag}>`; inList = false; }
      html += "<hr>";
    } else if (heading) {
      if (inList) { html += `</${listTag}>`; inList = false; }
      // # → h3 pour ne pas écraser la hiérarchie h1/h2 de la page hôte
      const lvl = Math.min(heading[1].length + 2, 6);
      html += `<h${lvl}>${heading[2]}</h${lvl}>`;
    } else if (ul || ol) {
      const tag = ul ? "ul" : "ol";
      if (!inList || listTag !== tag) {
        if (inList) html += `</${listTag}>`;
        html += `<${tag}>`;
        inList = true;
        listTag = tag;
      }
      html += `<li>${(ul || ol)[1]}</li>`;
    } else {
      if (inList) { html += `</${listTag}>`; inList = false; }
      if (line.trim() !== "") html += `<p>${line}</p>`;
    }
  }

  if (inList) html += `</${listTag}>`;

  // Réinjecter les blocs de code à leur position d'origine
  return html.replace(/\0(\d+)\0/g, (_, i) => blocks[+i]);
}
