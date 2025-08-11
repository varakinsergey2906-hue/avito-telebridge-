import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ===== ENV =====
const {
  PORT = 8080,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,

  // для автоответа
  AVITO_CLIENT_ID,
  AVITO_CLIENT_SECRET,
  AVITO_ACCOUNT_ID,        // у тебя 296724426 (можно задать в Env)

  DEBUG_RAW = "0",         // 1 — слать сырые JSON в TG (для отладки)
  FORCE_REPLY = "0"        // 1 — отвечать на КАЖДОЕ входящее (только для теста)
} = process.env;

// ===== helpers =====
async function tg(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
  });
}

function tsRuFromISO(iso) {
  const d = iso ? new Date(iso) : new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth()+1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function getAvitoAccessToken() {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: AVITO_CLIENT_ID,
    client_secret: AVITO_CLIENT_SECRET
  });
  const r = await fetch("https://api.avito.ru/token", { method: "POST", body });
  if (!r.ok) throw new Error(`Avito token failed: ${r.status}`);
  const j = await r.json();
  if (!j.access_token) throw new Error("No access_token");
  return j.access_token;
}

// ===== анти-дубли и лимит автоответа =====
const seen = new Map();              // messageId -> expiresAt (10 мин)
const MSG_TTL_MS = 10 * 60 * 1000;
function seenOnce(id) {
  const now = Date.now();
  for (const [k, exp] of seen) if (exp < now) seen.delete(k);
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.set(id, now + MSG_TTL_MS);
  return false;
}

const repliedChats = new Map();      // chat_id -> expiresAt (24 часа)
const REPLY_TTL_MS = 24 * 60 * 60 * 1000;
function shouldAutoReply(chatId) {
  const now = Date.now();
  for (const [k, exp] of repliedChats) if (exp < now) repliedChats.delete(k);
  if (!chatId) return false;
  if (repliedChats.has(chatId)) return false;
  repliedChats.set(chatId, now + REPLY_TTL_MS);
  return true;
}

// ===== health / ping =====
app.get("/", (_, res) => res.send("ok"));
app.get("/ping", async (req, res) => {
  try { await tg(String(req.query.text || "Пинг ✅")); res.send("sent"); }
  catch { res.status(500).send("error"); }
});

// ===== отправка автоответа (v1, как в доке) =====
async function sendAutoReply({ chatId, text }) {
  // 1) получить access_token
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: AVITO_CLIENT_ID,
    client_secret: AVITO_CLIENT_SECRET
  });
  const tokRes = await fetch("https://api.avito.ru/token", { method: "POST", body });
  if (!tokRes.ok) throw new Error(`token ${tokRes.status}`);
  const tok = await tokRes.json();
  const access = tok.access_token;

  // 2) аккаунт (твой user_id / номер профиля)
  const accountId = AVITO_ACCOUNT_ID || "296724426";

  // 3) правильный URL + тело
  const url = `https://api.avito.ru/messenger/v1/accounts/${encodeURIComponent(accountId)}/chats/${encodeURIComponent(chatId)}/messages`;
  const payload = {
    type: "text",
    message: {
      text: `Здравствуйте!

Спасибо, что написали. Чтобы связаться со мной и записаться на бесплатный пробный урок напишите в телеграм/вацап:

Телеграм:
https://t.me/varakinss
Вацап:
https://clck.ru/3MBJ8Z

Укажите, пожалуйста, сразу в каком вы классе и с чем нужна помощь`
    }
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${access}`,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const t = await r.text();
  await tg(`↩️ Автоответ: ${r.status}\n${t.slice(0,400)}`);
  if (![200,201,202,204].includes(r.status)) {
    throw new Error(`send fail ${r.status}`);
  }
  return true;
}

// ===== единый обработчик вебхука =====
async function handleWebhook(req, res) {
  try {
    const ev = req.body || {};
    const v  = ev?.payload?.value || {}; // v3

    // анти-дубль
    const messageId = v?.id || ev?.id;
    if (seenOnce(messageId)) return res.send("dup");

    if (DEBUG_RAW === "1") {
      try { await tg("📦 RAW:\n" + JSON.stringify(ev, null, 2).slice(0, 3500)); } catch {}
    }

    const text       = v?.content?.text || "(без текста)";
    const chatId     = v?.chat_id || "";
    const chatType   = v?.chat_type || "";
    const userId     = v?.user_id || "";      // твой аккаунт
    const authorId   = v?.author_id || "";    // отправитель (клиент)
    const itemId     = v?.item_id || "";
    const published  = v?.published_at || null;

    // карточка в TG
    const lines = [];
    const ts = tsRuFromISO(published);
    lines.push(`Собеседник: ${text}`);
    lines.push("");
    lines.push("ИСТОРИЯ");
    lines.push(`${ts} Я: `);
    lines.push(`${ts} Собеседник: ${text}`);
    lines.push("");
    const advTitle = itemId ? `Объявление #${itemId}` : "Без названия";
    const advUrl   = itemId ? `https://avito.ru/${itemId}` : "";
    lines.push(`${advTitle}${advUrl ? ` (${advUrl})` : ""}  [#adv${itemId || ""}]`);
    lines.push(`Собеседник: [#user${userId || ""}]`);
    lines.push("");
    lines.push(`${chatType ? chatType + ":" : ""}${chatId || "нет chat_id"}`);
    await tg(lines.join("\n"));

    // === автоответ: только от клиента, раз в 24ч (или FORCE) ===
    const force = FORCE_REPLY === "1";
    const isFromClient = authorId && userId && authorId !== userId;

    if (!chatId) {
      await tg("↩️ Автоответ пропущен: нет chat_id");
    } else if (!isFromClient) {
      // чтобы не заспамить, молчим; можно включить лог:
      // await tg("↩️ Автоответ пропущен: это не клиент (author_id == user_id)");
    } else if (!(force || shouldAutoReply(chatId))) {
      // молчим; можно включить лог:
      // await tg("↩️ Автоответ пропущен: уже отвечали за последние 24 часа");
    } else if (!AVITO_CLIENT_ID || !AVITO_CLIENT_SECRET) {
      await tg("↩️ Автоответ пропущен: нет AVITO_CLIENT_ID/SECRET");
    } else {
      try { await sendAutoReply({ chatId, text: "" }); }
      catch (e) { await tg(`↩️ Автоответ ошибка: ${e.message}`); }
    }

    res.send("ok");
  } catch (e) {
    await tg(`❗️Ошибка вебхука: ${e.message}`);
    res.status(200).send("ok");
  }
}

// Ловим оба пути
app.post("/webhook", handleWebhook);
app.post("/webhook/message", handleWebhook);

// старт
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
