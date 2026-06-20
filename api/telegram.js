const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function sendTelegram(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
}

async function getAllVirtual() {
  const raw = await redis.hgetall('jurors:virtual');
  if (!raw || Object.keys(raw).length === 0) return [];
  return Object.values(raw);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');

  try {
    const update = req.body;
    if (!update || !update.message) return res.status(200).send('OK');

    // Deduplicate
    const updateId = update.update_id;
    const lastId = await redis.get('telegram:lastUpdate');
    if (lastId && updateId <= Number(lastId)) return res.status(200).send('OK');
    await redis.set('telegram:lastUpdate', updateId);

    const chatId = update.message.chat.id;
    const text = (update.message.text || '').trim();

    // Handle /remove command
    if (text.toLowerCase() === '/remove') {
      const jurors = await getAllVirtual();
      const juror = jurors.find(j => j.chatId && String(j.chatId) === String(chatId));
      if (juror) {
        await redis.hdel('jurors:virtual', juror.id);
        await sendTelegram(chatId, '✅ You have been removed from the virtual jury pool.');
      } else {
        await sendTelegram(chatId, 'No linked registration found for this Telegram account.');
      }
      return res.status(200).send('OK');
    }

    // Handle /start command
    if (text.toLowerCase() === '/start') {
      await sendTelegram(chatId, '⚖️ <b>Deadwood Tribunal Court Clerk</b>\n\nSend your 6-character verification code to link your jury registration.\n\n<i>The only rule is that you must follow the rules.</i>');
      return res.status(200).send('OK');
    }

    // Try to match verification code (6 chars, alphanumeric)
    if (/^[A-Za-z0-9]{6}$/.test(text)) {
      const code = text.toUpperCase();
      const jurors = await getAllVirtual();
      const juror = jurors.find(j => j.code === code && !j.chatId);

      if (juror) {
        juror.chatId = chatId;
        await redis.hset('jurors:virtual', { [juror.id]: juror });
        await sendTelegram(chatId, `✅ Verified! You are registered as <b>${juror.name}</b> in the virtual jury pool.\n\nYou will receive a summons here if selected.\n\n<i>The only rule is that you must follow the rules.</i>`);
      } else {
        // Check if code exists but is already linked
        const alreadyLinked = jurors.find(j => j.code === code && j.chatId);
        if (alreadyLinked) {
          await sendTelegram(chatId, 'This code has already been used to verify a registration.');
        } else {
          await sendTelegram(chatId, 'Verification code not recognized. Please check and try again.');
        }
      }
      return res.status(200).send('OK');
    }

    // Catch-all
    await sendTelegram(chatId, 'The only rule is that you must follow the rules.');
    return res.status(200).send('OK');
  } catch (err) {
    console.error('Telegram webhook error:', err);
    return res.status(200).send('OK'); // Always 200 so Telegram doesn't retry
  }
};

