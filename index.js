import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ENV из Render
const {
  PORT = 8080,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  WEBHOOK_SHARED_SECRET,
  AVITO_CLIENT_ID,
  AVITO_CLIENT_SECRET
} = process.env;

// --- Telegram helper ---
async function tg(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" })
  });
}

// Healthcheck
app.get("/", (_, res) => res.sen_
