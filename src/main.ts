type Theme = "dark" | "light" | "ocean";

type Message = {
  id: string;
  chatId: string;
  author: string;
  text: string;
  createdAt: number;
  editedAt?: number;
  deletedAt?: number;
  deletedBy?: string;
};

type Chat = {
  id: string;
  title: string;
  members: string[];
  createdAt: number;
};

type AppState = {
  version: 2;
  theme: Theme;
  currentUser: string;
  chats: Chat[];
  messages: Message[];
  activeChatId: string | null;
};

const STORAGE_KEY = "mess_state_v1";
const CHANNEL_NAME = "mess_channel_v1";

type ServerSnapshot = {
  chats: Chat[];
  messages: Message[];
};

type ServerWire =
  | { type: "snapshot"; state: ServerSnapshot; sentAt: number }
  | { type: "joined"; you: string; sentAt: number }
  | {
      type: "op";
      op:
        | { type: "chatCreated"; chat: Chat }
        | { type: "chatUpdated"; chat: Chat }
        | { type: "messageSent"; message: Message }
        | { type: "messageEdited"; messageId: string; text: string; editedAt: number }
        | { type: "messageDeleted"; messageId: string; deletedAt: number; deletedBy: string };
      sentAt: number;
    };

type ServerOp = Extract<ServerWire, { type: "op" }>["op"];

function now(): number {
  return Date.now();
}

function uid(prefix: string): string {
  // Good enough for local-only app.
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function clampName(name: string): string {
  const v = name.trim().replace(/\s+/g, " ");
  return v.length ? v.slice(0, 40) : "Пользователь";
}

function parseMembers(raw: string): string[] {
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/\s+/g, " ").slice(0, 40));
  return Array.from(new Set(items));
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

const ui = {
  currentUserLabel: el<HTMLDivElement>("currentUserLabel"),
  settingsBtn: el<HTMLButtonElement>("settingsBtn"),
  newChatBtn: el<HTMLButtonElement>("newChatBtn"),
  chatSearch: el<HTMLInputElement>("chatSearch"),
  chatList: el<HTMLDivElement>("chatList"),
  activeChatTitle: el<HTMLDivElement>("activeChatTitle"),
  activeChatMeta: el<HTMLDivElement>("activeChatMeta"),
  messages: el<HTMLDivElement>("messages"),
  messageInput: el<HTMLTextAreaElement>("messageInput"),
  sendBtn: el<HTMLButtonElement>("sendBtn"),
  composerHint: el<HTMLDivElement>("composerHint"),
  newChatDialog: el<HTMLDialogElement>("newChatDialog"),
  newChatForm: el<HTMLFormElement>("newChatForm"),
  newChatTitle: el<HTMLInputElement>("newChatTitle"),
  newChatMembers: el<HTMLInputElement>("newChatMembers"),
  settingsDialog: el<HTMLDialogElement>("settingsDialog"),
  settingsForm: el<HTMLFormElement>("settingsForm"),
  themeSelect: el<HTMLSelectElement>("themeSelect"),
  registerDialog: el<HTMLDialogElement>("registerDialog"),
  registerForm: el<HTMLFormElement>("registerForm"),
  registerNameInput: el<HTMLInputElement>("registerNameInput"),
  overlay: el<HTMLDivElement>("overlay"),
  app: el<HTMLDivElement>("app"),
  mobileChatsBtn: el<HTMLButtonElement>("mobileChatsBtn"),
  shareChatBtn: el<HTMLButtonElement>("shareChatBtn"),
};

function getDefaultState(): AppState {
  const currentUser = "Пользователь";
  const generalChatId = uid("chat");

  return {
    version: 2,
    theme: "dark",
    currentUser,
    chats: [
      {
        id: generalChatId,
        title: "Общий чат",
        members: [currentUser],
        createdAt: now(),
      },
    ],
    messages: [
      {
        id: uid("msg"),
        chatId: generalChatId,
        author: "Mess",
        text:
          "Это локальный мессенджер без сервера.\n" +
          "Откройте страницу во второй вкладке — сообщения будут синхронизироваться.\n" +
          "Создайте групповой чат кнопкой “+ Чат”.\n" +
          "Свои сообщения можно редактировать и удалять “для всех”.",
        createdAt: now(),
      },
    ],
    activeChatId: generalChatId,
  };
}

function migrateToV2(s: any): AppState | null {
  if (!s || typeof s !== "object") return null;
  if (s.version === 2) return s as AppState;
  if (s.version !== 1) return null;
  if (typeof s.currentUser !== "string") return null;
  return {
    version: 2,
    theme: s.theme === "light" ? "light" : "dark",
    currentUser: String(s.currentUser),
    chats: Array.isArray(s.chats) ? (s.chats as Chat[]) : [],
    messages: Array.isArray(s.messages) ? (s.messages as Message[]) : [],
    activeChatId: typeof s.activeChatId === "string" ? s.activeChatId : null,
  };
}

function loadState(): AppState {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return getDefaultState();

  try {
    const parsed = JSON.parse(raw);
    const migrated = migrateToV2(parsed);
    if (migrated) return migrated;
  } catch {
    // ignore and reset
  }
  return getDefaultState();
}

function saveState(state: AppState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

type WireEvent =
  | { type: "sync"; state: AppState; from: string; sentAt: number }
  | { type: "poke"; from: string; sentAt: number };

const instanceId = uid("inst");
const channel = "BroadcastChannel" in window ? new BroadcastChannel(CHANNEL_NAME) : null;

function getWsUrl(): string | null {
  if (location.protocol !== "http:" && location.protocol !== "https:") return null;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}

let ws: WebSocket | null = null;
let serverMode = false;
let pendingChatFromUrl: string | null = null;
let reconnectAttempts = 0;
let reconnectTimer: number | null = null;
const MAX_RECONNECT_DELAY = 10000;
const registrationRequired = !localStorage.getItem(STORAGE_KEY);

function broadcast(ev: WireEvent): void {
  if (!channel) return;
  channel.postMessage(ev);
}

let state: AppState = loadState();

function mergeIncomingState(incoming: AppState): void {
  // Very simple last-write-wins merge: choose the state with more recent content.
  // We compare by max timestamp present in messages/chats.
  const maxTs = (s: AppState): number => {
    const m = s.messages.reduce(
      (acc, x) => Math.max(acc, x.createdAt, x.editedAt ?? 0, x.deletedAt ?? 0),
      0,
    );
    const c = s.chats.reduce((acc, x) => Math.max(acc, x.createdAt), 0);
    return Math.max(m, c);
  };

  if (maxTs(incoming) >= maxTs(state)) {
    const keepUser = state.currentUser;
    state = { ...incoming, currentUser: keepUser };
    applyTheme(state.theme);
    render();
  }
}

if (channel) {
  channel.addEventListener("message", (e: MessageEvent) => {
    const data = e.data as WireEvent;
    if (!data || typeof data !== "object") return;
    if ("from" in data && data.from === instanceId) return;

    if (data.type === "sync") {
      mergeIncomingState(data.state);
    } else if (data.type === "poke") {
      // Another tab asks for a state snapshot.
      broadcast({ type: "sync", state, from: instanceId, sentAt: now() });
    }
  });
}

function connectServer(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const wsUrl = getWsUrl();
  if (!wsUrl) return;

  ws = new WebSocket(wsUrl);

  ws.addEventListener("open", () => {
    serverMode = true;
    reconnectAttempts = 0;
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    ws?.send(JSON.stringify({ type: "join", currentUser: state.currentUser }));
  });

  ws.addEventListener("message", (e) => {
    const data = safeParseJson(String(e.data)) as ServerWire | null;
    if (!data || typeof data !== "object") return;

    if (data.type === "snapshot") {
      state.chats = data.state.chats ?? [];
      state.messages = data.state.messages ?? [];
      ensureActiveChat();
      applyChatFromUrlIfNeeded();
      render();
      return;
    }

    if (data.type === "op") {
      applyServerOp(data.op);
      applyChatFromUrlIfNeeded();
      render();
      return;
    }
  });

  ws.addEventListener("close", () => {
    // Fallback to local mode when server disconnects and keep retrying.
    serverMode = false;
    ws = null;
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    ws?.close();
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  const delay = Math.min(1000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY);
  reconnectAttempts += 1;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connectServer();
  }, delay);
}

function safeParseJson(s: string): unknown | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function applyServerOp(op: ServerOp): void {
  if (op.type === "chatCreated") {
    state.chats = [op.chat, ...state.chats.filter((c) => c.id !== op.chat.id)];
    if (!state.activeChatId) state.activeChatId = op.chat.id;
    return;
  }
  if (op.type === "chatUpdated") {
    state.chats = [op.chat, ...state.chats.filter((c) => c.id !== op.chat.id)];
    return;
  }
  if (op.type === "messageSent") {
    state.messages = [...state.messages.filter((m) => m.id !== op.message.id), op.message];
    return;
  }
  if (op.type === "messageEdited") {
    const m = state.messages.find((x) => x.id === op.messageId);
    if (!m) return;
    m.text = op.text;
    m.editedAt = op.editedAt;
    return;
  }
  if (op.type === "messageDeleted") {
    const m = state.messages.find((x) => x.id === op.messageId);
    if (!m) return;
    m.deletedAt = op.deletedAt;
    m.deletedBy = op.deletedBy;
    return;
  }
}

function ensureActiveChat(): void {
  if (state.activeChatId && state.chats.some((c) => c.id === state.activeChatId)) return;
  state.activeChatId = state.chats[0]?.id ?? null;
}

function setActiveChat(chatId: string): void {
  state.activeChatId = chatId;
  saveAndSync();
  render();
  closeDrawer();
  ui.messageInput.focus();
}

function getChatIdFromUrl(): string | null {
  const qs = new URLSearchParams(location.search);
  const id = qs.get("chat");
  return id && id.trim() ? id.trim() : null;
}

function setChatIdInUrl(chatId: string): void {
  const url = new URL(location.href);
  url.searchParams.set("chat", chatId);
  history.replaceState(null, "", url.toString());
}

function applyChatFromUrlIfNeeded(): void {
  if (!pendingChatFromUrl) return;
  const id = pendingChatFromUrl;
  const exists = state.chats.some((c) => c.id === id);
  if (!exists) return;
  state.activeChatId = id;
  pendingChatFromUrl = null;

  if (serverMode && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "op", op: { type: "joinChat", chatId: id } }));
  }
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function shareActiveChatLink(): Promise<void> {
  const chatId = state.activeChatId;
  if (!chatId) return;

  if (location.protocol === "http:" || location.protocol === "https:") {
    const url = new URL(location.href);
    url.searchParams.set("chat", chatId);
    const ok = await copyToClipboard(url.toString());
    if (!ok) prompt("Скопируйте ссылку:", url.toString());
    return;
  }

  alert("Ссылка работает в серверном режиме (http://localhost:3000). Запустите npm run start.");
}

function isMobileLayout(): boolean {
  return window.matchMedia("(max-width: 920px)").matches;
}

function openDrawer(): void {
  if (!isMobileLayout()) return;
  ui.app.classList.add("app--drawer-open");
  ui.overlay.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeDrawer(): void {
  ui.app.classList.remove("app--drawer-open");
  ui.overlay.hidden = true;
  document.body.style.overflow = "";
}

function createChat(title: string, members: string[]): void {
  if (serverMode && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "op", op: { type: "createChat", title, members } }));
    return;
  }
  const chat: Chat = {
    id: uid("chat"),
    title: title.trim().slice(0, 60) || "Без названия",
    members: Array.from(new Set([state.currentUser, ...members])),
    createdAt: now(),
  };
  state.chats.unshift(chat);
  state.activeChatId = chat.id;
  saveAndSync();
  render();
}

function sendMessage(text: string): void {
  const chatId = state.activeChatId;
  if (!chatId) return;

  const clean = text.trim();
  if (!clean) return;

  if (serverMode && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "op", op: { type: "sendMessage", chatId, text: clean } }));
    ui.messageInput.value = "";
    resizeComposerInput();
    updateSendAvailability();
    return;
  }

  const msg: Message = {
    id: uid("msg"),
    chatId,
    author: state.currentUser,
    text: clean.slice(0, 4000),
    createdAt: now(),
  };
  state.messages.push(msg);
  saveAndSync();
  renderMessages();
  ui.messageInput.value = "";
  resizeComposerInput();
  updateSendAvailability();
  ui.messages.scrollTop = ui.messages.scrollHeight;
}

function resizeComposerInput(): void {
  const input = ui.messageInput;
  input.style.height = "0px";
  const next = Math.max(42, Math.min(input.scrollHeight, 150));
  input.style.height = `${next}px`;
}

function updateSendAvailability(): void {
  const hasChat = Boolean(state.activeChatId);
  const hasText = ui.messageInput.value.trim().length > 0;
  ui.sendBtn.disabled = !hasChat || !hasText;
}

function canEditOrDelete(msg: Message): boolean {
  return msg.author === state.currentUser && !msg.deletedAt;
}

function editMessage(messageId: string): void {
  const msg = state.messages.find((m) => m.id === messageId);
  if (!msg) return;
  if (!canEditOrDelete(msg)) {
    alert("Можно редактировать только свои и не удалённые сообщения.");
    return;
  }

  const next = prompt("Редактировать сообщение:", msg.text);
  if (next === null) return;
  const clean = next.trim();
  if (!clean) return;

  if (serverMode && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "op", op: { type: "editMessage", messageId, text: clean } }));
    return;
  }

  msg.text = clean.slice(0, 4000);
  msg.editedAt = now();
  saveAndSync();
  renderMessages();
}

function deleteMessageForAll(messageId: string): void {
  const idx = state.messages.findIndex((m) => m.id === messageId);
  if (idx < 0) return;

  const msg = state.messages[idx]!;
  if (!canEditOrDelete(msg)) {
    alert("Можно удалять только свои и не удалённые сообщения.");
    return;
  }

  if (serverMode && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "op", op: { type: "deleteMessageForAll", messageId } }));
    return;
  }

  msg.deletedAt = now();
  msg.deletedBy = state.currentUser;
  saveAndSync();
  renderMessages();
}

function saveAndSync(): void {
  saveState(state);
  if (!serverMode) {
    broadcast({ type: "sync", state, from: instanceId, sentAt: now() });
  }
}

function setCurrentUserName(nextName: string): void {
  const prevName = state.currentUser;
  const cleanName = clampName(nextName);
  if (cleanName === prevName) return;
  state.currentUser = cleanName;
  state.chats = state.chats.map((chat) => {
    const members = Array.from(
      new Set(chat.members.map((member) => (member === prevName ? cleanName : member))),
    );
    return { ...chat, members };
  });
}

function renderChats(): void {
  const q = ui.chatSearch.value.trim().toLowerCase();
  const chats = q
    ? state.chats.filter((c) => c.title.toLowerCase().includes(q))
    : state.chats;

  ui.chatList.innerHTML = chats
    .map((c) => {
      const isActive = c.id === state.activeChatId;
      const last = [...state.messages].reverse().find((m) => m.chatId === c.id);
      const meta = last ? `${last.author}: ${last.text.replace(/\s+/g, " ").slice(0, 40)}` : "Нет сообщений";
      const members = c.members.length > 1 ? `${c.members.length} участников` : "личный";
      return `
        <div class="chatitem ${isActive ? "chatitem--active" : ""}" data-chat-id="${escapeHtml(c.id)}">
          <div>
            <div class="chatitem__title">${escapeHtml(c.title)}</div>
            <div class="chatitem__meta">${escapeHtml(meta)}</div>
          </div>
          <div class="chatitem__badge" title="${escapeHtml(c.members.join(", "))}">${escapeHtml(members)}</div>
        </div>
      `;
    })
    .join("");

  ui.chatList.querySelectorAll<HTMLElement>(".chatitem").forEach((node) => {
    node.addEventListener("click", () => {
      const id = node.dataset.chatId;
      if (id) setActiveChat(id);
    });
  });
}

function renderHeader(): void {
  ensureActiveChat();
  const active = state.activeChatId ? state.chats.find((c) => c.id === state.activeChatId) : null;

  if (!active) {
    ui.activeChatTitle.textContent = "Выберите чат";
    ui.activeChatMeta.textContent = "";
    ui.messageInput.disabled = true;
    ui.sendBtn.disabled = true;
    return;
  }

  ui.activeChatTitle.textContent = active.title;
  ui.activeChatMeta.textContent =
    active.members.length > 1 ? `Участники: ${active.members.join(", ")}` : "Личный чат";

  ui.messageInput.disabled = false;
  updateSendAvailability();
}

function renderMessages(): void {
  const chatId = state.activeChatId;
  if (!chatId) {
    ui.messages.innerHTML = "";
    return;
  }

  const list = state.messages.filter((m) => m.chatId === chatId);
  ui.messages.innerHTML = list
    .map((m) => {
      const mine = m.author === state.currentUser;
      const isDeleted = Boolean(m.deletedAt);
      const bodyText = isDeleted ? "Сообщение удалено" : m.text;
      const edited = !isDeleted && m.editedAt ? ` • ред. ${formatTime(m.editedAt)}` : "";
      const authorLine = `${m.author}${edited}`;

      const actions =
        mine && !isDeleted
          ? [
              `<button class="btn btn--ghost" data-action="edit" data-msg-id="${escapeHtml(m.id)}" type="button">Ред.</button>`,
              `<button class="btn btn--danger" data-action="delete" data-msg-id="${escapeHtml(m.id)}" type="button">Удалить</button>`,
            ].join("")
          : "";
      return `
        <div class="msg ${mine ? "msg--mine" : ""}">
          <div class="msg__top">
            <div class="msg__author">${escapeHtml(authorLine)}</div>
            <div class="msg__time">${escapeHtml(formatTime(m.createdAt))}</div>
          </div>
          <div class="msg__text">${escapeHtml(bodyText)}</div>
          <div class="msg__actions">${actions}</div>
        </div>
      `;
    })
    .join("");

  ui.messages.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.msgId;
      if (!id) return;
      const action = btn.dataset.action;
      if (action === "delete") deleteMessageForAll(id);
      if (action === "edit") editMessage(id);
    });
  });
}

function render(): void {
  ui.currentUserLabel.textContent = `Вы: ${state.currentUser}`;
  applyTheme(state.theme);
  ui.themeSelect.value = state.theme;
  renderHeader();
  renderChats();
  renderMessages();
  updateSendAvailability();
  resizeComposerInput();
}

function initEvents(): void {
  ui.settingsBtn.addEventListener("click", () => {
    ui.themeSelect.value = state.theme;
    ui.settingsDialog.showModal();
  });

  ui.newChatBtn.addEventListener("click", () => {
    ui.newChatTitle.value = "";
    ui.newChatMembers.value = "";
    ui.newChatDialog.showModal();
    setTimeout(() => ui.newChatTitle.focus(), 0);
  });

  ui.mobileChatsBtn.addEventListener("click", () => {
    openDrawer();
  });

  ui.shareChatBtn.addEventListener("click", () => {
    void shareActiveChatLink();
  });

  ui.overlay.addEventListener("click", () => {
    closeDrawer();
  });

  window.addEventListener("resize", () => {
    if (!isMobileLayout()) closeDrawer();
  });

  ui.newChatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const title = ui.newChatTitle.value;
    const members = parseMembers(ui.newChatMembers.value);
    if (!title.trim()) return;
    ui.newChatDialog.close();
    createChat(title, members);
  });

  ui.settingsForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const selected = ui.themeSelect.value;
    if (selected === "dark" || selected === "light" || selected === "ocean") {
      state.theme = selected;
      applyTheme(state.theme);
      saveAndSync();
      render();
    }
    ui.settingsDialog.close();
  });

  ui.registerDialog.addEventListener("cancel", (e) => {
    if (registrationRequired) e.preventDefault();
  });

  ui.registerForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const entered = ui.registerNameInput.value.trim();
    if (!entered) return;
    setCurrentUserName(entered);
    saveAndSync();
    render();
    ui.registerDialog.close();
    if (!serverMode) {
      connectServer();
      if (!serverMode) {
        broadcast({ type: "poke", from: instanceId, sentAt: now() });
      }
    }
  });

  ui.chatSearch.addEventListener("input", () => {
    renderChats();
  });

  ui.sendBtn.addEventListener("click", () => {
    sendMessage(ui.messageInput.value);
  });

  ui.messageInput.addEventListener("input", () => {
    updateSendAvailability();
    resizeComposerInput();
  });

  ui.messageInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(ui.messageInput.value);
    }
  });

  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    const updated = loadState();
    mergeIncomingState(updated);
  });
}

function boot(): void {
  pendingChatFromUrl = getChatIdFromUrl();
  initEvents();
  if (!registrationRequired) {
    // Ask other tabs for their freshest snapshot.
    connectServer();
    if (!serverMode) {
      broadcast({ type: "poke", from: instanceId, sentAt: now() });
    }
  }
  if (pendingChatFromUrl) {
    // In local mode we can apply immediately (state already loaded).
    applyChatFromUrlIfNeeded();
    if (state.activeChatId) setChatIdInUrl(state.activeChatId);
  }
  render();
  if (registrationRequired) {
    ui.registerNameInput.value = state.currentUser === "Пользователь" ? "" : state.currentUser;
    ui.registerDialog.showModal();
    setTimeout(() => ui.registerNameInput.focus(), 0);
  }
}

boot();

