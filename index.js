import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ===== ENV =====
const {
  PORT = 8080,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  // для автоответа:
  AVITO_CLIENT_ID,
  AVITO_CLIENT_SECRET,
  AVITO_ACCOUNT_ID,        // твой ID профиля (у тебя 296724426)
  DEBUG_RAW = "0",         // 1 — слать сырые JSON в TG (для отладки)
  FORCE_REPLY = "0"        // 1 — отвечать на КАЖДОЕ входящее (временный тест)
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

// если AVITO_ACCOUNT_ID не указан — получим сами (один раз)
let cachedAccountId = AVITO_ACCOUNT_ID || null;
async function ensureAccountId(token) {
  if (cachedAccountId) return cachedAccountId;
  const r = await fetch("https://api.avito.ru/core/v1/accounts/self", {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) throw new Error(`Get self failed: ${r.status}`);
  const j = await r.json();
  cachedAccountId = String(j?.id || "");
  if (!cachedAccountId) throw new Error("No account_id");
  return cachedAccountId;
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

const repliedChats = new Map();      // chat_id -> expiresAt (12 часов)
const REPLY_TTL_MS = 12 * 60 * 60 * 1000;
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

// ===== автоответ: отправка (v3, корректный маршрут) =====
async function sendAutoReply({ chatId, text }) {
  const access = await getAvitoAccessToken();
  const accountId = await ensureAccountId(access);

  const base = `https://api.avito.ru/messenger/v3/accounts/${encodeURIComponent(accountId)}/chats/${encodeURIComponent(chatId)}`;

  const urls = [
    `${base}/messages`,
    `${base}/messages/text`,
    `${base}/messages:send`
  ];

  const bodies = [
    { type: "text", content: { text } },            // A
    { message: { content: { text } } },             // B
    { text }                                        // C
  ];

  let sent = false, log = [];
  outer: for (const url of urls) {
    for (const body of bodies) {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${access}`,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify(body)
      });
      const t = await r.text();
      log.push(`${r.status} — ${url}\n${t.slice(0,300)}\nBODY=${JSON.stringify(body)}`);
      if ([200,201,202,204].includes(r.status)) { sent = true; break outer; }
    }
  }
  await tg(`↩️ Автоответ: ${sent ? "успех" : "не отправлен"}\n` + log.join("\n\n"));
  return sent;
}

// ===== единый обработчик вебхука =====
async function handleWebhook(req, res) {
  try {
    const ev = req.body || {};
    const v  = ev?.payload?.value || {}; // v3

    // анти-дубль: иногда Авито ретраит одно и то же
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

    // карточка в TG (как раньше)
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

    // === автоответ (аккуратно) ===
    // шлём ТОЛЬКО если это написал клиент (author_id != user_id),
    // и это первый раз за 12 часов, либо включён FORCE_REPLY
    const force = FORCE_REPLY === "1";
    const isFromClient = authorId && userId && authorId !== userId;

    if (!chatId) {
      await tg("↩️ Автоответ пропущен: нет chat_id");
    } else if (!isFromClient) {
      await tg("↩️ Автоответ пропущен: это не клиент (author_id == user_id)");
    } else if (!(force || shouldAutoReply(chatId))) {
      await tg("↩️ Автоответ пропущен: уже отвечали в этот чат за последние 12 часов");
    } else if (!AVITO_CLIENT_ID || !AVITO_CLIENT_SECRET) {
      await tg("↩️ Автоответ пропущен: нет AVITO_CLIENT_ID/SECRET");
    } else {
      const replyText =
        "Здравствуйте!\n" +
        "Спасибо за интерес к моим занятиям по химии. Чтобы быстрее обсудить детали и подобрать удобное время для бесплатного пробного урока, напишите мне в Telegram @varakin_s или оставьте ваш номер WhatsApp — я свяжусь с вами сразу как смогу.\n\n" +
        "Пожалуйста, укажите вашу цель: подготовка к ЕГЭ/ОГЭ, помощь с учебой, олимпиадная химия или что-то другое. Жду вашего сообщения!";

      try { await sendAutoReply({ chatId, text: replyText }); }
      catch (e) { await tg(`↩️ Автоответ ошибка: ${e.message}`); }
    }

    res.send("ok");
  } catch (e) {
    await tg(`❗️Ошибка вебхука: ${e.message}`);
    res.status(200).send("ok");
  }
}

// Ловим оба пути — чтобы не промахнуться
app.post("/webhook", handleWebhook);
app.post("/webhook/message", handleWebhook);

// старт
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
