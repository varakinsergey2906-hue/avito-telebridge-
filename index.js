import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ===== ENV (фиксированные имена) =====
const {
  PORT = 8080,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  AVITO_CLIENT_ID,
  AVITO_CLIENT_SECRET,
  DEBUG_RAW = "0",          // 1 = присылать сырые JSON в Telegram
  FORCE_REPLY = "0"         // 1 = отвечать на каждое сообщение
} = process.env;

// ===== анти-дубли сообщений (по message.id) =====
const seen = new Map(); // id -> expiresAt
const MSG_TTL_MS = 10 * 60 * 1000;
function seenOnce(id) {
  const now = Date.now();
  for (const [k, exp] of seen) if (exp < now) seen.delete(k);
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.set(id, now + MSG_TTL_MS);
  return false;
}

// ===== автоответ только 1 раз на чат / 12 часов =====
const repliedChats = new Map(); // chat_id -> expiresAt
const REPLY_TTL_MS = 12 * 60 * 60 * 1000;
function shouldAutoReply(chatId) {
  const now = Date.now();
  for (const [k, exp] of repliedChats) if (exp < now) repliedChats.delete(k);
  if (!chatId) return false;
  if (repliedChats.has(chatId)) return false;
  repliedChats.set(chatId, now + REPLY_TTL_MS);
  return true;
}

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

// ===== health / ping =====
app.get("/", (_, res) => res.send("ok"));
app.get("/ping", async (req, res) => {
  try { await tg(String(req.query.text || "Пинг ✅")); res.send("sent"); }
  catch { res.status(500).send("error"); }
});

// ===== регистрация вебхука кнопкой =====
app.get("/setup/register", async (req, res) => {
  try {
    const access = await getAvitoAccessToken();
    const webhookUrl = `https://${req.headers.host}/webhook/message`;
    const candidates = [
      "https://api.avito.ru/messenger/v3/webhook",
      "https://api.avito.ru/messenger/v2/webhook",
      "https://api.avito.ru/messenger/v1/webhooks",
      "https://api.avito.ru/messenger/v1/webhook"
    ];
    const results = [];
    for (const url of candidates) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Authorization": `Bearer ${access}`, "Content-Type": "application/json" },
          body: JSON.stringify({ url: webhookUrl })
        });
        const text = await r.text();
        results.push({ url, status: r.status, text });
        if ([200,201,204].includes(r.status)) break;
      } catch (e) { results.push({ url, status: "ERR", text: e.message }); }
    }
    const summary = results.map(x => `${x.status} — ${x.url}\n${(x.text||"").slice(0,200)}`).join("\n\n");
    await tg(`⚙️ Регистрация вебхука:\n${summary}`);
    res.status(200).send(`Готово. Смотри Telegram.\n\n${summary}`);
  } catch (e) {
    await tg(`❗️Ошибка регистрации вебхука: ${e.message}`);
    res.status(500).send(e.message);
  }
});

// ===== основной вебхук (v3 payload) =====
app.post("/webhook/message", async (req, res) => {
  try {
    const ev = req.body || {};
    const v  = ev?.payload?.value || {}; // v3

    // анти-дубль по id
    const messageId = v?.id || ev?.id;
    if (seenOnce(messageId)) return res.send("dup");

    if (DEBUG_RAW === "1") {
      try { await tg("📦 RAW:\n" + JSON.stringify(ev, null, 2).slice(0, 3500)); } catch {}
    }

    const text      = v?.content?.text || "(без текста)";
    const chatId    = v?.chat_id || "";
    const chatType  = v?.chat_type || "";
    const userId    = v?.user_id || "";
    const itemId    = v?.item_id || "";
    const published = v?.published_at || null;

    // карточка
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

    // ===== автоответ =====
    const force = FORCE_REPLY === "1";
    if (!chatId) {
      await tg("↩️ Автоответ пропущен: нет chat_id в событии");
    } else if (!(force || shouldAutoReply(chatId))) {
      await tg("↩️ Автоответ пропущен: уже отвечали в этот чат за последние 12 часов");
    } else {
      try {
        const access = await getAvitoAccessToken();
        const urls = [
          "https://api.avito.ru/messenger/v3/messages",
          "https://api.avito.ru/messenger/v3/messages/send",
          `https://api.avito.ru/messenger/v3/chats/${encodeURIComponent(chatId)}/messages`
        ];
        const bodies = [
          { chat_id: chatId, user_id: userId, type: "text", message: { content: { text: "Привет! Спасибо за обращение 👋 Отвечу в течение 10–30 минут." } } },
          { chat_id: chatId, user_id: userId, message: { content: { text: "Привет! Спасибо за обращение 👋 Отвечу в течение 10–30 минут." } } },
          { chat_id: chatId, user_id: userId, message: { text: "Привет! Спасибо за обращение 👋 Отвечу в течение 10–30 минут." } }
        ];
        let sent = false, debug = [];
        outer: for (const url of urls) {
          for (const body of bodies) {
            const r = await fetch(url, {
              method: "POST",
              headers: { "Authorization": `Bearer ${access}`, "Content-Type": "application/json" },
              body: JSON.stringify(body)
            });
            const t = await r.text();
            debug.push(`${r.status} — ${url}\n${t.slice(0,200)}\nBODY=${JSON.stringify(body)}`);
            if ([200,201,202,204].includes(r.status)) { sent = true; break outer; }
          }
        }
        await tg(`↩️ Автоответ: ${sent ? "успех" : "не отправлен"}\n` + debug.join("\n\n"));
      } catch (e) {
        await tg(`↩️ Автоответ ошибка: ${e.message}`);
      }
    }

    res.send("ok");
  } catch (e) {
    await tg(`❗️Ошибка вебхука: ${e.message}`);
    res.status(200).send("ok");
  }
});

// ===== старт =====
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
