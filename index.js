import express from "express";
import axios from "axios";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN; // токен бота
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // твой id чата
const AVITO_TOKEN = process.env.AVITO_TOKEN; // токен Avito API

// Запоминаем чаты, куда уже отправили автоответ
const repliedChats = new Set();

// === Вебхук Avito ===
app.post("/webhook", async (req, res) => {
    const rawData = JSON.stringify(req.body, null, 2);
    console.log("RAW webhook:", rawData);

    if (req.body?.payload?.type === "message") {
        const msg = req.body.payload.value;
        const chatId = msg.chat_id;
        const userId = msg.user_id;
        const text = msg.content?.text || "(без текста)";
        const itemId = msg.item_id;

        // Формируем красивое сообщение в Telegram
        const tgMessage = `📢 Новое сообщение с Avito\n` +
            `Собеседник: ${text}\n\n` +
            `Объявление #${itemId} (https://avito.ru/${itemId})\n` +
            `chat_id: ${chatId}\nuser_id: ${userId}`;

        await sendTelegram(tgMessage);

        // Автоответ только на первое сообщение в чате
        if (!repliedChats.has(chatId)) {
            repliedChats.add(chatId);
            await sendAvitoMessage(chatId, userId,
                "Здравствуйте! Спасибо за интерес к моим занятиям по химии. Чтобы быстрее обсудить детали и подобрать удобное время для бесплатного пробного урока, напишите мне в Telegram @varakin_s или оставьте ваш номер WhatsApp — я свяжусь с вами сразу как смогу.\n\nПожалуйста, укажите вашу цель: подготовка к ЕГЭ/ОГЭ, помощь с учебой, олимпиадная химия или что-то другое. Жду вашего сообщения!"
            );
        }
    }

    res.sendStatus(200);
});

// === Тестовый эндпоинт для ручной отправки ===
app.get("/debug/send", async (req, res) => {
    const chatId = req.query.chat_id;
    const userId = req.query.user_id;
    if (!chatId || !userId) {
        return res.send("Нужно передать chat_id и user_id в query params");
    }

    const result = await sendAvitoMessage(chatId, userId, "Тестовое сообщение от бота 🚀");
    res.send(result);
});

// === Функция отправки в Telegram ===
async function sendTelegram(text) {
    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text
        });
    } catch (err) {
        console.error("Ошибка отправки в Telegram:", err.response?.data || err.message);
    }
}

// === Функция отправки в Avito ===
async function sendAvitoMessage(chatId, userId, text) {
    try {
        const resp = await axios.post(
            `https://api.avito.ru/messenger/v1/accounts/${userId}/chats/${chatId}/messages`,
            {
                type: "text",
                message: {
                    content: { text }
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${AVITO_TOKEN}`,
                    "Content-Type": "application/json"
                }
            }
        );
        return resp.data;
    } catch (err) {
        console.error("Ошибка отправки в Avito:", err.response?.data || err.message);
        return err.response?.data || err.message;
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
