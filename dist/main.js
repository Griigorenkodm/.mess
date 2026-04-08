"use strict";
const STORAGE_KEY = "mess_state_v1";
const CHANNEL_NAME = "mess_channel_v1";
function now() {
    return Date.now();
}
function uid(prefix) {
    // Good enough for local-only app.
    return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}
function clampName(name) {
    const v = name.trim().replace(/\s+/g, " ");
    return v.length ? v.slice(0, 40) : "Пользователь";
}
function parseMembers(raw) {
    const items = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.replace(/\s+/g, " ").slice(0, 40));
    return Array.from(new Set(items));
}
function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        day: "2-digit",
        month: "2-digit",
    });
}
function escapeHtml(s) {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
function el(id) {
    const node = document.getElementById(id);
    if (!node)
        throw new Error(`Missing element #${id}`);
    return node;
}
const ui = {
    currentUserLabel: el("currentUserLabel"),
    themeToggle: el("themeToggle"),
    newChatBtn: el("newChatBtn"),
    chatSearch: el("chatSearch"),
    chatList: el("chatList"),
    activeChatTitle: el("activeChatTitle"),
    activeChatMeta: el("activeChatMeta"),
    messages: el("messages"),
    messageInput: el("messageInput"),
    sendBtn: el("sendBtn"),
    composerHint: el("composerHint"),
    newChatDialog: el("newChatDialog"),
    newChatForm: el("newChatForm"),
    newChatTitle: el("newChatTitle"),
    newChatMembers: el("newChatMembers"),
    overlay: el("overlay"),
    app: el("app"),
    mobileChatsBtn: el("mobileChatsBtn"),
    shareChatBtn: el("shareChatBtn"),
};
function getDefaultState() {
    var _a;
    const currentUser = clampName((_a = prompt("Ваше имя?")) !== null && _a !== void 0 ? _a : "Пользователь");
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
                text: "Это локальный мессенджер без сервера.\n" +
                    "Откройте страницу во второй вкладке — сообщения будут синхронизироваться.\n" +
                    "Создайте групповой чат кнопкой “+ Чат”.\n" +
                    "Свои сообщения можно редактировать и удалять “для всех”.",
                createdAt: now(),
            },
        ],
        activeChatId: generalChatId,
    };
}
function migrateToV2(s) {
    if (!s || typeof s !== "object")
        return null;
    if (s.version === 2)
        return s;
    if (s.version !== 1)
        return null;
    if (typeof s.currentUser !== "string")
        return null;
    return {
        version: 2,
        theme: s.theme === "light" ? "light" : "dark",
        currentUser: String(s.currentUser),
        chats: Array.isArray(s.chats) ? s.chats : [],
        messages: Array.isArray(s.messages) ? s.messages : [],
        activeChatId: typeof s.activeChatId === "string" ? s.activeChatId : null,
    };
}
function loadState() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw)
        return getDefaultState();
    try {
        const parsed = JSON.parse(raw);
        const migrated = migrateToV2(parsed);
        if (migrated)
            return migrated;
    }
    catch {
        // ignore and reset
    }
    return getDefaultState();
}
function saveState(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
}
function toggleTheme(state) {
    state.theme = state.theme === "dark" ? "light" : "dark";
    applyTheme(state.theme);
}
const instanceId = uid("inst");
const channel = "BroadcastChannel" in window ? new BroadcastChannel(CHANNEL_NAME) : null;
function getWsUrl() {
    if (location.protocol !== "http:" && location.protocol !== "https:")
        return null;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws`;
}
let ws = null;
let serverMode = false;
let pendingChatFromUrl = null;
function broadcast(ev) {
    if (!channel)
        return;
    channel.postMessage(ev);
}
let state = loadState();
function mergeIncomingState(incoming) {
    // Very simple last-write-wins merge: choose the state with more recent content.
    // We compare by max timestamp present in messages/chats.
    const maxTs = (s) => {
        const m = s.messages.reduce((acc, x) => { var _a, _b; return Math.max(acc, x.createdAt, (_a = x.editedAt) !== null && _a !== void 0 ? _a : 0, (_b = x.deletedAt) !== null && _b !== void 0 ? _b : 0); }, 0);
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
    channel.addEventListener("message", (e) => {
        const data = e.data;
        if (!data || typeof data !== "object")
            return;
        if ("from" in data && data.from === instanceId)
            return;
        if (data.type === "sync") {
            mergeIncomingState(data.state);
        }
        else if (data.type === "poke") {
            // Another tab asks for a state snapshot.
            broadcast({ type: "sync", state, from: instanceId, sentAt: now() });
        }
    });
}
function connectServer() {
    const wsUrl = getWsUrl();
    if (!wsUrl)
        return;
    ws = new WebSocket(wsUrl);
    serverMode = true;
    ws.addEventListener("open", () => {
        ws === null || ws === void 0 ? void 0 : ws.send(JSON.stringify({ type: "join", currentUser: state.currentUser }));
    });
    ws.addEventListener("message", (e) => {
        var _a, _b;
        const data = safeParseJson(String(e.data));
        if (!data || typeof data !== "object")
            return;
        if (data.type === "snapshot") {
            state.chats = (_a = data.state.chats) !== null && _a !== void 0 ? _a : [];
            state.messages = (_b = data.state.messages) !== null && _b !== void 0 ? _b : [];
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
        // Fallback to local mode when server disconnects.
        serverMode = false;
        ws = null;
    });
}
function safeParseJson(s) {
    try {
        return JSON.parse(s);
    }
    catch {
        return null;
    }
}
function applyServerOp(op) {
    if (op.type === "chatCreated") {
        state.chats = [op.chat, ...state.chats.filter((c) => c.id !== op.chat.id)];
        if (!state.activeChatId)
            state.activeChatId = op.chat.id;
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
        if (!m)
            return;
        m.text = op.text;
        m.editedAt = op.editedAt;
        return;
    }
    if (op.type === "messageDeleted") {
        const m = state.messages.find((x) => x.id === op.messageId);
        if (!m)
            return;
        m.deletedAt = op.deletedAt;
        m.deletedBy = op.deletedBy;
        return;
    }
}
function ensureActiveChat() {
    var _a, _b;
    if (state.activeChatId && state.chats.some((c) => c.id === state.activeChatId))
        return;
    state.activeChatId = (_b = (_a = state.chats[0]) === null || _a === void 0 ? void 0 : _a.id) !== null && _b !== void 0 ? _b : null;
}
function setActiveChat(chatId) {
    state.activeChatId = chatId;
    saveAndSync();
    render();
    closeDrawer();
    ui.messageInput.focus();
}
function getChatIdFromUrl() {
    const qs = new URLSearchParams(location.search);
    const id = qs.get("chat");
    return id && id.trim() ? id.trim() : null;
}
function setChatIdInUrl(chatId) {
    const url = new URL(location.href);
    url.searchParams.set("chat", chatId);
    history.replaceState(null, "", url.toString());
}
function applyChatFromUrlIfNeeded() {
    if (!pendingChatFromUrl)
        return;
    const id = pendingChatFromUrl;
    const exists = state.chats.some((c) => c.id === id);
    if (!exists)
        return;
    state.activeChatId = id;
    pendingChatFromUrl = null;
    if (serverMode && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "op", op: { type: "joinChat", chatId: id } }));
    }
}
async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    }
    catch {
        return false;
    }
}
async function shareActiveChatLink() {
    const chatId = state.activeChatId;
    if (!chatId)
        return;
    if (location.protocol === "http:" || location.protocol === "https:") {
        const url = new URL(location.href);
        url.searchParams.set("chat", chatId);
        const ok = await copyToClipboard(url.toString());
        if (!ok)
            prompt("Скопируйте ссылку:", url.toString());
        return;
    }
    alert("Ссылка работает в серверном режиме (http://localhost:3000). Запустите npm run start.");
}
function isMobileLayout() {
    return window.matchMedia("(max-width: 920px)").matches;
}
function openDrawer() {
    if (!isMobileLayout())
        return;
    ui.app.classList.add("app--drawer-open");
    ui.overlay.hidden = false;
    document.body.style.overflow = "hidden";
}
function closeDrawer() {
    ui.app.classList.remove("app--drawer-open");
    ui.overlay.hidden = true;
    document.body.style.overflow = "";
}
function createChat(title, members) {
    if (serverMode && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "op", op: { type: "createChat", title, members } }));
        return;
    }
    const chat = {
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
function sendMessage(text) {
    const chatId = state.activeChatId;
    if (!chatId)
        return;
    const clean = text.trim();
    if (!clean)
        return;
    if (serverMode && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "op", op: { type: "sendMessage", chatId, text: clean } }));
        ui.messageInput.value = "";
        return;
    }
    const msg = {
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
    ui.messages.scrollTop = ui.messages.scrollHeight;
}
function canEditOrDelete(msg) {
    return msg.author === state.currentUser && !msg.deletedAt;
}
function editMessage(messageId) {
    const msg = state.messages.find((m) => m.id === messageId);
    if (!msg)
        return;
    if (!canEditOrDelete(msg)) {
        alert("Можно редактировать только свои и не удалённые сообщения.");
        return;
    }
    const next = prompt("Редактировать сообщение:", msg.text);
    if (next === null)
        return;
    const clean = next.trim();
    if (!clean)
        return;
    if (serverMode && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "op", op: { type: "editMessage", messageId, text: clean } }));
        return;
    }
    msg.text = clean.slice(0, 4000);
    msg.editedAt = now();
    saveAndSync();
    renderMessages();
}
function deleteMessageForAll(messageId) {
    const idx = state.messages.findIndex((m) => m.id === messageId);
    if (idx < 0)
        return;
    const msg = state.messages[idx];
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
function saveAndSync() {
    saveState(state);
    if (!serverMode) {
        broadcast({ type: "sync", state, from: instanceId, sentAt: now() });
    }
}
function renderChats() {
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
    ui.chatList.querySelectorAll(".chatitem").forEach((node) => {
        node.addEventListener("click", () => {
            const id = node.dataset.chatId;
            if (id)
                setActiveChat(id);
        });
    });
}
function renderHeader() {
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
    ui.sendBtn.disabled = false;
}
function renderMessages() {
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
        const actions = mine && !isDeleted
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
    ui.messages.querySelectorAll("button[data-action]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const id = btn.dataset.msgId;
            if (!id)
                return;
            const action = btn.dataset.action;
            if (action === "delete")
                deleteMessageForAll(id);
            if (action === "edit")
                editMessage(id);
        });
    });
}
function render() {
    ui.currentUserLabel.textContent = `Вы: ${state.currentUser}`;
    applyTheme(state.theme);
    renderHeader();
    renderChats();
    renderMessages();
}
function initEvents() {
    ui.themeToggle.addEventListener("click", () => {
        toggleTheme(state);
        saveAndSync();
        render();
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
        if (!isMobileLayout())
            closeDrawer();
    });
    ui.newChatForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const title = ui.newChatTitle.value;
        const members = parseMembers(ui.newChatMembers.value);
        if (!title.trim())
            return;
        ui.newChatDialog.close();
        createChat(title, members);
    });
    ui.chatSearch.addEventListener("input", () => {
        renderChats();
    });
    ui.sendBtn.addEventListener("click", () => {
        sendMessage(ui.messageInput.value);
    });
    ui.messageInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage(ui.messageInput.value);
        }
    });
    window.addEventListener("storage", (e) => {
        if (e.key !== STORAGE_KEY)
            return;
        const updated = loadState();
        mergeIncomingState(updated);
    });
}
function boot() {
    pendingChatFromUrl = getChatIdFromUrl();
    // Ask other tabs for their freshest snapshot.
    connectServer();
    if (!serverMode) {
        broadcast({ type: "poke", from: instanceId, sentAt: now() });
    }
    initEvents();
    if (pendingChatFromUrl) {
        // In local mode we can apply immediately (state already loaded).
        applyChatFromUrlIfNeeded();
        if (state.activeChatId)
            setChatIdInUrl(state.activeChatId);
    }
    render();
}
boot();
//# sourceMappingURL=main.js.map