import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ============ настройки ============
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT = process.env.TG_CHAT;
const AVITO_CLIENT_ID = process.env.AVITO_CLIENT_ID;
const AVITO_CLIENT_SECRET = process.env.AVITO_CLIENT_SECRET;
const AUTO_REPLY_TEXT = "Здравствуйте! Отвечу вам в ближайшее время.";
const FORCE_REPLY = process.env.FORCE_REPLY === "1";

// Хранилище отправок (память сервера)
const repliedChats = {};

// ============ функции ============
async function tg(text) {
  return fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT, text }),
  });
}

async function getAvitoAccessToken() {
  const res = await fetch("https://api.avito.ru/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: AVITO_CLIENT_ID,
      client_secret: AVITO_CLIENT_SECRET,
    }),
  });
  const data = await res.json();
  return data.access_token;
}

function shouldAutoReply(chatId) {
  const last = repliedChats[chatId];
  if (!last) return true;
  return Date.now() - last > 12 * 60 * 60 * 1000; // 12 часов
}

// ============ вебхук ============
app.post("/webhook/message", async (req, res) => {
  const raw = JSON.stringify(req.body, null, 2);
  await tg(`📦 RAW:\n${raw}`);

  const payload = req.body?.payload?.value;
  const chatId = payload?.chat_id;
  const userId = payload?.user_id;
  const text = payload?.content?.text || "(без текста)";
  const itemId = payload?.item_id;

  await tg(`Собеседник: ${text}\n\nОбъявление #${itemId || ""}\nchat_id: ${chatId || "нет"} user_id: ${userId || "нет"}`);

  // ===== автоответ =====
  if (!chatId) {
    await tg("↩️ Автоответ пропущен: нет chat_id в событии");
  } else if (!(FORCE_REPLY || shouldAutoReply(chatId))) {
    await tg("↩️ Автоответ пропущен: уже отвечали в этот чат за последние 12 часов");
  } else {
    try {
      const access = await getAvitoAccessToken();
      const body = {
        message: { text: AUTO_REPLY_TEXT },
      };
      const r = await fetch(`https://api.avito.ru/messenger/v3/messages?user_id=${userId}&chat_id=${chatId}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const respText = await r.text();
      await tg(`↩️ Автоответ: ${r.status}\n${respText}`);
      repliedChats[chatId] = Date.now();
    } catch (err) {
      await tg(`↩️ Автоответ ошибка: ${err.message}`);
    }
  }

  res.send("ok");
});

// ============ старт ============
app.get("/", (_, res) => res.send("OK"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on ${PORT}`));
