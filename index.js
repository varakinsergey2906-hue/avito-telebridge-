import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// переменные из Render → Environment
const {
  PORT = 8080,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  WEBHOOK_SHARED_SECRET,
  AVITO_CLIENT_ID,
  AVITO_CLIENT_SECRET
} = process.env;

// ----- отправка в Telegram -----
async function tg(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" })
  });
  return r.ok;
}

// healthcheck
app.get("/", (_, res) => res.send("ok"));

// ручной пинг (проверка телеги)
app.get("/ping", async (req, res) => {
  try {
    await tg(String(req.query.text || "Пинг ✅"));
    res.send("sent");
  } catch (e) {
    res.status(500).send("error");
  }
});

// !!! ТВОЙ ВЕБХУК ОТ AVITO (переименованный)
app.post("/webhook/message", async (req, res) => {
  // необязательная проверка секрета
  if (WEBHOOK_SHARED_SECRET && req.headers["x-webhook-signature"] !== WEBHOOK_SHARED_SECRET) {
    return res.status(401).send("bad signature");
  }

  const ev = req.body || {};
  const title = ev?.context?.value?.title || ev?.ad_title || "Без названия";
  const text  = ev?.message?.text || ev?.text || "(без текста)";
  const chatId = ev?.chat_id || "нет chat_id";
  const userId = ev?.user_id || ev?.user?.id || "нет user_id";

  const msg = [
    "🟢 <b>Новое сообщение</b>",
    `Объявление: <i>${title}</i>`,
    `chat_id: <code>${chatId}</code>  user_id: <code>${userId}</code>`,
    "— — —",
    text
  ].join("\n");

  try { await tg(msg.slice(0, 4000)); } catch {}
  res.send("ok");
});

// ====== СЕРВИСНАЯ ССЫЛКА ДЛЯ РЕГИСТРАЦИИ ВЕБХУКА В AVITO ======
async function getAvitoAccessToken() {
  if (!AVITO_CLIENT_ID || !AVITO_CLIENT_SECRET) throw new Error("No Avito creds");
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

// откроешь эту ссылку один раз: зарегистрируем URL вебхука в Авито
app.get("/setup/register", async (req, res) => {
  try {
    const access = await getAvitoAccessToken();
    const webhookUrl = `https://${req.headers.host}/webhook/message`;

    // Важно: эндпоинт может отличаться у Авито. У многих это messenger/v1/webhook.
    // Если вернёт 404/403 — пришли текст из логов Render, я поправлю путь/права.
    const r = await fetch("https://api.avito.ru/messenger/v1/webhook", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${access}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ url: webhookUrl })
    });

    const text = await r.text();
    await tg(`⚙️ Регистрация вебхука: ${r.status}\n${text}`);
    res.status(200).send(`Webhook register status: ${r.status} — смотри Telegram и логи.`);
  } catch (e) {
    await tg(`❗️Ошибка регистрации вебхука: ${e.message}`);
    res.status(500).send(e.message);
  }
});

app.listen(PORT, () => console.log("Listening on", PORT));
