import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ===== ENV =====
const {
  PORT = 8080,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  WEBHOOK_SHARED_SECRET,   // оставь пустым, если Авито не шлёт подпись
  AVITO_CLIENT_ID,
  AVITO_CLIENT_SECRET
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

function tsRu(date = new Date()) {
  const d = date;
  const pad = n => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ===== health / ping =====
app.get("/", (_, res) => res.send("ok"));

app.get("/ping", async (req, res) => {
  try {
    await tg(String(req.query.text || "Пинг ✅"));
    res.send("sent");
  } catch (e) {
    res.status(500).send("error");
  }
});

// ===== Avito OAuth (client_credentials) =====
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

// ===== регистрация вебхука «кнопкой» =====
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

// ===== основной вебхук =====
app.post("/webhook/message", async (req, res) => {
  try {
    // если включал секрет — проверь заголовок (иначе оставь ENV пустым)
    if (WEBHOOK_SHARED_SECRET && req.headers["x-webhook-signature"] !== WEBHOOK_SHARED_SECRET) {
      return res.status(401).send("bad signature");
    }

    const ev = req.body || {};

    // отладка: пришлём сырые данные (обрежем до 3500 символов)
    try { await tg("📦 RAW:\n" + JSON.stringify(ev, null, 2).slice(0, 3500)); } catch {}

    // вытаскиваем поля из разных возможных мест
    const adv = {
      id: ev?.payload?.ad?.id ?? ev?.ad_id,
      title: ev?.payload?.ad?.title ?? ev?.payload?.title ?? ev?.context?.value?.title ?? ev?.ad_title ?? "Без названия",
      url: ev?.payload?.ad?.url || (ev?.payload?.ad?.id ? `https://avito.ru/${ev.payload.ad.id}` : ""),
      price: ev?.payload?.ad?.price_text || ev?.payload?.price_text || ""
    };

    const me = {
      id: ev?.payload?.account?.id,
      name: ev?.payload?.account?.name || "",
      url: ev?.payload?.account?.url || "",
      phone: ev?.payload?.account?.phone || ""
    };

    const user = {
      id: ev?.payload?.user?.id ?? ev?.user_id ?? ev?.user?.id,
      name: ev?.payload?.user?.name || ev?.user?.name || "Собеседник",
      url: ev?.payload?.user?.url || ""
    };

    const chat = {
      id: ev?.payload?.chat_id ?? ev?.payload?.chat?.id ?? ev?.chat_id ?? ev?.chat?.id ?? ""
    };

    const text =
      ev?.payload?.message?.text ||
      ev?.message?.text ||
      ev?.text ||
      "(без текста)";

    // формируем карточку в твоём стиле
    const lines = [];
    lines.push(`${user.name}: ${text}`);
    lines.push("");
    lines.push("ИСТОРИЯ");
    const now = tsRu();
    lines.push(`${now} ${me.name}: `);
    lines.push(`${now} ${user.name}: ${text}`);
    lines.push("");
    const pricePart = adv.price ? ` (${adv.price})` : "";
    const urlPart = adv.url ? ` (${adv.url})` : "";
    lines.push(`${adv.title}${pricePart}${urlPart}  [#adv${adv.id || ""}]`);
    const accIdTag = me.id ? ` [#acc${me.id}]` : "";
    const usrIdTag = user.id ? ` [#user${user.id}]` : "";
    lines.push(`Аккаунт: ${me.name} ${me.phone || ""}${accIdTag}`);
    const userUrlPart = user.url ? ` (${user.url})` : "";
    lines.push(`Собеседник: ${user.name}${userUrlPart}${usrIdTag}`);
    if (ev?.payload?.ad?.location) lines.push(`Локация: ${ev.payload.ad.location}`);
    lines.push("");
    lines.push(String(chat.id || "нет chat_id"));

    await tg(lines.join("\n"));

    // ===== автоответ в чат Авито (можно отредактировать текст) =====
    const autoReply = [
      "Привет! Спасибо за обращение 👋",
      "Отвечу в течение 10–30 минут. Если срочно — напишите в Telegram: @your_username.",
      "Когда удобно созвониться?"
    ].join("\n");

    if (chat.id) {
      try {
        const access = await getAvitoAccessToken();
        const payload = { chat_id: chat.id, user_id: user.id, message: { text: autoReply } };
        const sendCandidates = [
          "https://api.avito.ru/messenger/v3/messages",
          "https://api.avito.ru/messenger/v2/messages",
          "https://api.avito.ru/messenger/v1/messages"
        ];
        let sent = false, debug = [];
        for (const url of sendCandidates) {
          const r = await fetch(url, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${access}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
          });
          const t = await r.text();
          debug.push(`${r.status} — ${url}\n${t.slice(0,200)}`);
          if ([200,201,202,204].includes(r.status)) { sent = true; break; }
        }
        await tg(`↩️ Автоответ: ${sent ? "успех" : "не отправлен"}\n` + debug.join("\n\n"));
      } catch (e) {
        await tg(`❗️Ошибка автоответа: ${e.message}`);
      }
    }

    res.send("ok");
  } catch (e) {
    await tg(`❗️Ошибка вебхука: ${e.message}`);
    res.status(200).send("ok");
  }
});

// ===== start =====
app.listen(PORT, () => console.log("Listening on", PORT));
