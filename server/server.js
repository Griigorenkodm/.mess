const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(__dirname, "db.json");

function now() {
  return Date.now();
}

function uid(prefix) {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function loadDb() {
  if (!fs.existsSync(DB_PATH)) {
    const seed = {
      version: 1,
      chats: [
        {
          id: uid("chat"),
          title: "Общий чат",
          members: [],
          createdAt: now(),
        },
      ],
      messages: [],
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(seed, null, 2), "utf8");
  }
  const raw = fs.readFileSync(DB_PATH, "utf8");
  const parsed = safeJsonParse(raw);
  if (!parsed || !Array.isArray(parsed.chats) || !Array.isArray(parsed.messages)) {
    throw new Error("Bad db.json format");
  }
  return parsed;
}

function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

const db = loadDb();

const app = express();
app.disable("x-powered-by");

// Serve static app
app.use(express.static(ROOT));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(data);
    }
  }
}

function getChatById(chatId) {
  return db.chats.find((c) => c.id === chatId) || null;
}

function getMsgById(messageId) {
  return db.messages.find((m) => m.id === messageId) || null;
}

function normalizeName(name) {
  if (typeof name !== "string") return "Пользователь";
  const v = name.trim().replace(/\s+/g, " ");
  return v.length ? v.slice(0, 40) : "Пользователь";
}

wss.on("connection", (ws) => {
  ws.user = { name: "Пользователь" };

  ws.send(
    JSON.stringify({
      type: "snapshot",
      state: { chats: db.chats, messages: db.messages },
      sentAt: now(),
    }),
  );

  ws.on("message", (buf) => {
    const msg = safeJsonParse(String(buf));
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "join") {
      ws.user.name = normalizeName(msg.currentUser);
      ws.send(JSON.stringify({ type: "joined", you: ws.user.name, sentAt: now() }));
      return;
    }

    if (msg.type !== "op" || !msg.op || typeof msg.op !== "object") return;
    const op = msg.op;

    // Operations: createChat | joinChat | sendMessage | editMessage | deleteMessageForAll
    if (op.type === "createChat") {
      const title = typeof op.title === "string" ? op.title.trim().slice(0, 60) : "";
      const members = Array.isArray(op.members)
        ? Array.from(
            new Set(
              op.members
                .filter((x) => typeof x === "string")
                .map((x) => x.trim().replace(/\s+/g, " ").slice(0, 40))
                .filter(Boolean),
            ),
          )
        : [];

      const chat = {
        id: uid("chat"),
        title: title || "Без названия",
        members: Array.from(new Set([ws.user.name, ...members])),
        createdAt: now(),
      };
      db.chats.unshift(chat);
      saveDb(db);
      broadcast({ type: "op", op: { type: "chatCreated", chat }, sentAt: now() });
      return;
    }

    if (op.type === "joinChat") {
      const chatId = typeof op.chatId === "string" ? op.chatId : "";
      if (!chatId) return;
      const chat = getChatById(chatId);
      if (!chat) return;
      if (!Array.isArray(chat.members)) chat.members = [];
      if (!chat.members.includes(ws.user.name)) {
        chat.members.push(ws.user.name);
        saveDb(db);
        broadcast({ type: "op", op: { type: "chatUpdated", chat }, sentAt: now() });
      }
      return;
    }

    if (op.type === "sendMessage") {
      const chatId = typeof op.chatId === "string" ? op.chatId : "";
      const text = typeof op.text === "string" ? op.text.trim().slice(0, 4000) : "";
      if (!chatId || !text) return;
      if (!getChatById(chatId)) return;

      const message = {
        id: uid("msg"),
        chatId,
        author: ws.user.name,
        text,
        createdAt: now(),
      };
      db.messages.push(message);
      saveDb(db);
      broadcast({ type: "op", op: { type: "messageSent", message }, sentAt: now() });
      return;
    }

    if (op.type === "editMessage") {
      const messageId = typeof op.messageId === "string" ? op.messageId : "";
      const text = typeof op.text === "string" ? op.text.trim().slice(0, 4000) : "";
      if (!messageId || !text) return;

      const m = getMsgById(messageId);
      if (!m) return;
      if (m.author !== ws.user.name) return;
      if (m.deletedAt) return;

      m.text = text;
      m.editedAt = now();
      saveDb(db);
      broadcast({ type: "op", op: { type: "messageEdited", messageId, text: m.text, editedAt: m.editedAt }, sentAt: now() });
      return;
    }

    if (op.type === "deleteMessageForAll") {
      const messageId = typeof op.messageId === "string" ? op.messageId : "";
      if (!messageId) return;

      const m = getMsgById(messageId);
      if (!m) return;
      if (m.author !== ws.user.name) return;
      if (m.deletedAt) return;

      m.deletedAt = now();
      m.deletedBy = ws.user.name;
      saveDb(db);
      broadcast({ type: "op", op: { type: "messageDeleted", messageId, deletedAt: m.deletedAt, deletedBy: m.deletedBy }, sentAt: now() });
      return;
    }
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Mess server running: http://localhost:${PORT}`);
});

