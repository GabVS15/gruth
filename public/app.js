import {
  TITLE_MAX_LENGTH,
  TEXTAREA_MAX_HEIGHT,
  MESSAGE_MAX_CHARS,
  API_ENDPOINT,
  FALLBACK_ANSWER,
  ONBOARDING_KEY,
  ICON_DELETE,
  ICON_ASSISTANT_AVATAR,
} from "./js/config.js";
import { loadConversations, saveConversations } from "./js/storage.js";
import { renderMarkdown } from "./js/markdown.js";

const $ = (sel) => document.querySelector(sel);

const els = {
  welcome:        $("#welcome"),
  messages:       $("#messages"),
  chatScroll:     $("#chatScroll"),
  composer:       $("#composer"),
  input:          $("#input"),
  sendBtn:        $("#sendBtn"),
  newChat:        $("#newChat"),
  history:        $("#history"),
  sidebar:        $("#sidebar"),
  toggleSidebar:  $("#toggleSidebar"),
  toggleSidebar2: $("#toggleSidebar2"),
  backdrop:       $("#sidebarBackdrop"),
  app:            document.querySelector(".app"),
  main:           document.querySelector(".main"),
  // Déplacé en JS entre .welcome (accueil) et .main (conversation) pour le centrage vertical
  composerWrap:   document.querySelector(".composer-wrap"),
  onboarding:      $("#onboarding"),
  onboPage1:       $("#onboPage1"),
  onboPage2:       $("#onboPage2"),
  onboNext:        $("#onboNext"),
  onboStart:       $("#onboStart"),
  debugOnboarding: $("#debugOnboarding"),
};

function setHomeState(isHome) {
  els.app.classList.toggle("home", isHome);
  els.welcome.classList.toggle("hidden", !isHome);
  if (isHome) {
    els.welcome.appendChild(els.composerWrap);
  } else {
    els.main.appendChild(els.composerWrap);
  }
}

let conversations = loadConversations();
let currentId = null;
let streaming = false;

function currentConv() {
  return conversations.find((c) => c.id === currentId) || null;
}

function newConversation() {
  const conv = { id: crypto.randomUUID(), title: "Nouvelle conversation", messages: [] };
  conversations.unshift(conv);
  currentId = conv.id;
  saveConversations(conversations);
  renderHistory();
  renderMessages();
}

function renderHistory() {
  els.history.innerHTML = "";
  conversations.forEach((conv) => {
    const row = document.createElement("div");
    row.className = "history-item" + (conv.id === currentId ? " active" : "");

    const title = document.createElement("button");
    title.className = "history-title";
    title.textContent = conv.title;
    title.title = conv.title;
    title.onclick = () => {
      currentId = conv.id;
      renderHistory();
      renderMessages();
      setSidebar(false);
    };

    const del = document.createElement("button");
    del.className = "history-delete";
    del.setAttribute("aria-label", "Supprimer la conversation");
    del.title = "Supprimer";
    del.innerHTML = ICON_DELETE;
    del.onclick = (e) => {
      e.stopPropagation();
      deleteConversation(conv.id);
    };

    row.append(title, del);
    els.history.appendChild(row);
  });
}

function deleteConversation(id) {
  conversations = conversations.filter((c) => c.id !== id);
  saveConversations(conversations);
  if (currentId === id) {
    if (conversations.length > 0) {
      currentId = conversations[0].id;
    } else {
      newConversation();
      return;
    }
  }
  renderHistory();
  renderMessages();
}

function renderMessages() {
  const conv = currentConv();
  els.messages.innerHTML = "";
  setHomeState(!conv || conv.messages.length === 0);
  if (!conv) return;
  conv.messages.forEach((m) => addMessageEl(m.role, m.content));
  scrollToBottom();
}

function addMessageEl(role, content) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  if (role === "user") {
    avatar.textContent = "V";
  } else {
    avatar.innerHTML = ICON_ASSISTANT_AVATAR;
  }

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const roleEl = document.createElement("div");
  roleEl.className = "role";
  roleEl.textContent = role === "user" ? "Vous" : "GRuth";

  const contentEl = document.createElement("div");
  contentEl.className = "content";
  contentEl.innerHTML = renderMarkdown(content);

  bubble.append(roleEl, contentEl);
  wrap.append(avatar, bubble);
  els.messages.appendChild(wrap);
  return contentEl;
}

function scrollToBottom() {
  els.chatScroll.scrollTop = els.chatScroll.scrollHeight;
}

function setStreaming(on) {
  streaming = on;
  els.sendBtn.disabled = on || els.input.value.trim() === "";
}

async function sendMessage(text) {
  text = text.trim();
  if (!text || streaming) return;

  // Garde-fou anti-spam : on tronque tout message dépassant la limite de caractères
  // (le serveur rejette de toute façon au-delà de MAX_MESSAGE_CHARS).
  if (text.length > MESSAGE_MAX_CHARS) {
    text = text.slice(0, MESSAGE_MAX_CHARS);
  }

  let conv = currentConv();
  if (!conv) { newConversation(); conv = currentConv(); }

  if (conv.messages.length === 0) {
    conv.title = text.length > TITLE_MAX_LENGTH ? text.slice(0, TITLE_MAX_LENGTH) + "…" : text;
  }

  conv.messages.push({ role: "user", content: text });
  setHomeState(false);
  addMessageEl("user", text);
  saveConversations(conversations);
  renderHistory();

  els.input.value = "";
  autoGrow();
  scrollToBottom();
  setStreaming(true);

  const contentEl = addMessageEl("assistant", "");
  contentEl.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
  scrollToBottom();

  let answer = "";
  try {
    const res = await fetch(API_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: conv.messages }),
    });

    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Erreur ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split("\n");
      buffer = parts.pop();

      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content || "";
          if (delta) {
            answer += delta;
            contentEl.innerHTML = renderMarkdown(answer) + '<span class="cursor"></span>';
            scrollToBottom();
          }
        } catch { /* fragment SSE incomplet */ }
      }
    }

    contentEl.innerHTML = renderMarkdown(answer || FALLBACK_ANSWER);
    conv.messages.push({ role: "assistant", content: answer });
    saveConversations(conversations);
  } catch (err) {
    contentEl.innerHTML = renderMarkdown(
      `⚠️ **Erreur :** ${err.message}\n\nVérifiez que le serveur est démarré et que la clé API Mistral est configurée.`
    );
  } finally {
    setStreaming(false);
    scrollToBottom();
  }
}

function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, TEXTAREA_MAX_HEIGHT) + "px";
}

els.input.addEventListener("input", () => {
  autoGrow();
  els.sendBtn.disabled = streaming || els.input.value.trim() === "";
});

els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage(els.input.value);
  }
});

els.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage(els.input.value);
});

function setSidebar(open) {
  els.sidebar.classList.toggle("open", open);
  els.backdrop.classList.toggle("show", open);
}
const toggleSidebar = () => setSidebar(!els.sidebar.classList.contains("open"));
els.toggleSidebar?.addEventListener("click", toggleSidebar);
els.toggleSidebar2?.addEventListener("click", toggleSidebar);
els.backdrop?.addEventListener("click", () => setSidebar(false));

document.querySelectorAll(".has-popover").forEach((wrap) => {
  const trigger = wrap.querySelector("button");
  trigger?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const wasOpen = wrap.classList.contains("open");
    document.querySelectorAll(".has-popover.open").forEach((w) => w.classList.remove("open"));
    if (!wasOpen) wrap.classList.add("open");
  });
});

document.addEventListener("click", () => {
  document.querySelectorAll(".has-popover.open").forEach((w) => w.classList.remove("open"));
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.querySelectorAll(".has-popover.open").forEach((w) => w.classList.remove("open"));
    setSidebar(false);
  }
});

els.newChat.addEventListener("click", () => { newConversation(); setSidebar(false); });

if (conversations.length > 0) {
  currentId = conversations[0].id;
} else {
  newConversation();
}
renderHistory();
renderMessages();
els.input.focus();

// Onboarding — affiché une seule fois à la première visite
function initOnboarding() {
  if (localStorage.getItem(ONBOARDING_KEY)) return;
  setTimeout(() => els.onboarding.classList.add("show"), 200);
}

function showOnboarding() {
  els.onboPage1.classList.add("active");
  els.onboPage2.classList.remove("active");
  els.onboarding.classList.add("show");
}

els.onboNext?.addEventListener("click", () => {
  els.onboPage1.classList.remove("active");
  els.onboPage2.classList.add("active");
});

els.onboStart?.addEventListener("click", () => {
  els.onboarding.classList.remove("show");
  localStorage.setItem(ONBOARDING_KEY, "1");
});

els.debugOnboarding?.addEventListener("click", () => {
  setSidebar(false);
  showOnboarding();
});

initOnboarding();
