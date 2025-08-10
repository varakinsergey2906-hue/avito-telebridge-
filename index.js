app.get("/setup/register", async (req, res) => {
  try {
    const access = await getAvitoAccessToken();
    const webhookUrl = `https://${req.headers.host}/webhook/message`;

    // Набор возможных путей регистрации вебхука у Avito.
    const candidates = [
      "https://api.avito.ru/messenger/v3/webhook",
      "https://api.avito.ru/messenger/v2/webhook",
      "https://api.avito.ru/messenger/v1/webhooks",
      "https://api.avito.ru/messenger/v1/webhook",
      "https://api.avito.ru/messenger/webhook",
      "https://api.avito.ru/notifications/v1/webhook",
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
        // Если успех (200/201/204) — дальше пробовать не нужно
        if ([200,201,204].includes(r.status)) break;
      } catch (e) {
        results.push({ url, status: "ERR", text: e.message });
      }
    }

    // Отправим сводку в Telegram и на страницу
    const summary = results.map(x => `${x.status} — ${x.url}\n${x.text?.slice(0,200) || ""}`).join("\n\n");
    await tg(`⚙️ Результат регистрации вебхука:\n${summary}`);
    res.status(200).send(`Готово. Смотри подробности в Telegram.\n\n${summary}`);
  } catch (e) {
    await tg(`❗️Ошибка регистрации вебхука: ${e.message}`);
    res.status(500).send(e.message);
  }
});
