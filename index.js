import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const {
  PORT = 8080,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  WEBHOOK_SHARED_SECRET,
  AVITO_CLIENT_ID,
  AVITO_CLIENT_SECRET
} = process.env;

async function tg(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" })
  });
}

// healthcheck
app.get("/", (_, res) => res.send("ok"));

// ping -> сообщение в Telegram
app.get("/ping", async (req, res) => {
  try {
    await tg(String(req.query.text || "Пинг ✅"));
    res.send("sent");
  } catch (e) {
    res.status(500).send("error");
  }
});

// вебхук для сообщений
app.post("/webhook/message", async (req, res) => {
  try {
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

    await tg(msg.slice(0, 4000));
    res.send("ok");
  } catch (e) {
    await tg(`❗️Ошибка вебхука: ${e.message}`);
    res.status(200).send("ok");
  }
});

// Avito OAuth client_credentials
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

// регистрация вебхука (пробуем несколько путей)
app.get("/setup/register", async (req, res) => {
  try {
    const access = await getAvitoAccessToken();
    const webhookUrl = `https://${req.headers.host}/webhook/message`;

    const candidates = [
      "https://api.avito.ru/messenger/v3/webhook",
      "https://api.avito.ru/messenger/v2/webhook",
      "https://api.avito.ru/messenger/v1/webhooks",
      "https://api.avito.ru/messenger/v1/webhook",
      "https://api.avito.ru/messenger/webhook",
      "https://api.avito.ru/notifications/v1/webhook"
    ];

    const results = [];
    for (const url of candidates) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${access}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ url: webhookUrl })
        });
        const text = await r.text();
        results.push({ url, status: r.status, text });
        if ([200,201,204].includes(r.status)) break;
      } catch (e) {
        results.push({ url, status: "ERR", text: e.message });
      }
    }

    const summary = results.map(x => `${x.status} — ${x.url}\n${(x.text||"").slice(0,200)}`).join("\n\n");
    await tg(`⚙️ Регистрация вебхука:\n${summary}`);
    res.status(200).send(`Готово. Смотри Telegram.\n\n${summary}`);
  } catch (e) {
    await tg(`❗️Ошибка регистрации вебхука: ${e.message}`);
    res.status(500).send(e.message);
  }
});

app.listen(PORT, () => console.log("Listening on", PORT));
