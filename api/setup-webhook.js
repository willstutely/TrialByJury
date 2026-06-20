const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE_URL = process.env.BASE_URL || 'https://badlandstbj.com';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('GET only');

  const webhookUrl = `${BASE_URL}/api/telegram`;
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}&drop_pending_updates=true`;

  try {
    const resp = await fetch(url);
    const data = await resp.json();
    res.json({ ok: data.ok, description: data.description, webhook_url: webhookUrl });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
