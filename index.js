import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ==== ENV (оставляем как раньше) ====
const {
  PORT = 8080,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  DEBUG_RAW = "0" // 1 — присылать сырые JSON для отладки
} = process.env;

// ==== отправка в Telegram ====
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

// ==== health / ping ====
app.get("/", (_, res) => res.send("ok"));
app.get("/ping", async (req, res) => {
  try { await tg(String(req.query.text || "Пинг ✅")); res.send("sent"); }
  catch { res.status(500).send("error"); }
});

// ==== обработчик (общий для /webhook и /webhook/message) ====
async function handleWebhook(req, res) {
  try {
    const ev = req.body || {};
    if (DEBUG_RAW === "1") {
      try { await tg("📦 RAW:\n" + JSON.stringify(ev, null, 2).slice(0, 3500)); } catch {}
    }

    // v3-схема Avito → payload.value.*
    const v = ev?.payload?.value || {};
    const text      = v?.content?.text || "(без текста)";
    const chatId    = v?.chat_id || "";
    const chatType  = v?.chat_type || "";
    const userId    = v?.user_id || "";
    const itemId    = v?.item_id || "";
    const published = v?.published_at || null;

    // карточка в ТГ (как мы делали раньше)
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
    res.send("ok");
  } catch (e) {
    await tg(`❗️Ошибка вебхука: ${e.message}`);
    res.status(200).send("ok");
  }
}

// Ловим оба пути — чтобы не промахнуться
app.post("/webhook", handleWebhook);
app.post("/webhook/message", handleWebhook);

// ==== старт ====
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
