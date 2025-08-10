import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ===== Настройки =====
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const AVITO_CLIENT_ID = process.env.AVITO_CLIENT_ID;
const AVITO_CLIENT_SECRET = process.env.AVITO_CLIENT_SECRET;

// ===== Память для антидублей сообщений =====
const processedMessages = new Set();
function isDuplicate(messageId) {
  if (!messageId) return false;
  if (processedMessages.has(messageId)) return true;
  processedMessages.add(messageId);
  if (processedMessages.size > 1000) processedMessages.clear();
  return false;
}

// ===== Память для автоответов (чтобы слать 1 раз на чат в 12 ч) =====
const repliedChats = new Map(); // chat_id -> expiresAt
const REPLY_TTL_MS = 12 * 60 * 60 * 1000; // 12 часов

function shouldAutoReply(chatId) {
  const now = Date.now();
  // Чистим устаревшие записи
  for (const [k, exp] of repliedChats) {
    if (exp < now) repliedChats.delete(k);
  }
  if (!chatId) return false;
  if (repliedChats.has(chatId)) return false; // уже отвечали
  repliedChats.set(chatId, now + REPLY_TTL_MS);
  return true;
}

// ===== Утилиты =====
async function tg(text) {
  return fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
  });
}

async function getAvitoAccessToken() {
  const r = await fetch("https://api.avito.ru/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `client_id=${AVITO_CLIENT_ID}&client_secret=${AVITO_CLIENT_SECRET}&grant_type=client_credentials`
  });
  const j = await r.json();
  return j.access_token;
}

// ===== Обработчик входящих сообщений =====
app.post("/webhook/message", async (req, res) => {
  res.sendStatus(200);

  const raw = req.body;
  const msg = raw?.payload?.value;
  const messageId = msg?.id;

  if (isDuplicate(messageId)) return;

  const chatId = msg?.chat_id;
  const userId = msg?.user_id;
  const text = msg?.content?.text || "(без текста)";
  const itemId = msg?.item_id;

  // Отправляем в Telegram
  await tg(
    `📦 RAW:\n${JSON.stringify(raw, null, 2)}\n\n` +
    `Собеседник: ${text}\n\n` +
    `Объявление #${itemId} (${itemId ? `https://avito.ru/${itemId}` : ""}) [#adv${itemId}]\n` +
    `Собеседник: [#user${userId}]\n\n` +
    `${msg?.chat_type}:${chatId}`
  );

  // ===== Автоответ =====
  if (shouldAutoReply(chatId)) {
    const autoReply = [
      "Привет! Спасибо за обращение 👋",
      "Отвечу в течение 10–30 минут. Если срочно — напишите в Telegram: @your_username.",
      "Когда удобно созвониться?"
    ].join("\n");

    try {
      const access = await getAvitoAccessToken();

      const bodies = [
        { chat_id: chatId, user_id: userId, type: "text", message: { content: { text: autoReply } } },
        { chat_id: chatId, user_id: userId, message: { content: { text: autoReply } } },
        { chat_id: chatId, user_id: userId, message: { text: autoReply } }
      ];

      const urls = [
        "https://api.avito.ru/messenger/v3/messages",
        "https://api.avito.ru/messenger/v3/messages/send",
        `https://api.avito.ru/messenger/v3/chats/${encodeURIComponent(chatId)}/messages`,
        "https://api.avito.ru/messenger/v2/messages",
        "https://api.avito.ru/messenger/v1/messages",
        "https://api.avito.ru/messenger/messages"
      ];

      let sent = false, debug = [];
      outer: for (const url of urls) {
        for (const body of bodies) {
          const r = await fetch(url, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${access}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
          });
          const t = await r.text();
          debug.push(`${r.status} — ${url}\n${t.slice(0,200)}\nBODY=${JSON.stringify(body)}`);
          if ([200,201,202,204].includes(r.status)) { sent = true; break outer; }
          try { const j = JSON.parse(t); if (j && j.ok === true) { sent = true; break outer; } } catch {}
        }
      }

      await tg(`↩️ Автоответ: ${sent ? "успех" : "не отправлен"}\n` + debug.join("\n\n"));
    } catch (e) {
      await tg(`❗️Ошибка автоответа: ${e.message}`);
    }
  }
});

// ===== Старт сервера =====
app.get("/", (_, res) => res.send("OK"));
app.listen(10000, () => console.log("Server started"));
