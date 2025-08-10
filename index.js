import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const {
  PORT = 8080,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  WEBHOOK_SHARED_SECRET
} = process.env;

async function tg(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = { chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" };
  const r = await fetch(url, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(body)
  });
  return r.ok;
}

app.get("/", (_, res) => res.send("ok"));

app.get("/ping", async (req, res) => {
  try {
    const t = req.query.text || "Пинг с Render ✅";
    await tg(String(t));
    res.send("sent");
  } catch (e) {
    res.status(500).send("error");
  }
});

app.post("/webhook/message", async (req, res) => {
  // Простая проверка подписи (по желанию): передавай тот же секрет в заголовке X-Webhook-Signature
  if (WEBHOOK_SHARED_SECRET && req.headers["x-webhook-signature"] !== WEBHOOK_SHARED_SECRET) {
    return res.status(401).send("bad signature");
  }
  const ev = req.body || {};
  const title = ev?.context?.value?.title || ev?.ad_title || "Без названия";
  const text  = ev?.message?.text || ev?.text || "(без текста)";
  const chatId = ev?.chat_id || "нет chat_id";
  const userId = ev?.user_id || ev?.user?.id || "нет user_id";

  const msg = [
    "🟢 <b>Новое сообщение с Avito</b>",
    `Объявление: <i>${title}</i>`,
    `chat_id: <code>${chatId}</code>  user_id: <code>${userId}</code>`,
    "— — —",
    text
  ].join("\n");

  try { await tg(msg.slice(0, 4000)); } catch {}
  res.send("ok");
});

app.listen(PORT, () => console.log("Listening on", PORT));
