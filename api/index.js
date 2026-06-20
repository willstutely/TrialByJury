const { Redis } = require('@upstash/redis');
const crypto = require('crypto');

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BASE_URL = process.env.BASE_URL || 'https://badlandstbj.com';

// ── Helpers ────────────────────────────────────────────────

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function genId() { return crypto.randomUUID().split('-')[0]; }
function genCode() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }
function genToken() { return crypto.randomUUID(); }

async function getAllJurors(type) {
  const raw = await redis.hgetall(`jurors:${type}`);
  if (!raw || Object.keys(raw).length === 0) return [];
  return Object.values(raw).sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
}

async function sendTelegram(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  return resp.json();
}

// ── Actions ────────────────────────────────────────────────

async function handleAdd(body) {
  const { name, type } = body;
  if (!name || !type) return { ok: false, error: 'Missing name or type' };
  const id = genId();
  const juror = { id, name: name.trim(), timestamp: new Date().toISOString() };
  if (type === 'virtual') {
    juror.code = genCode();
    juror.chatId = null;
    juror.selected = false;
    juror.voteToken = null;
    juror.vote = null;
    juror.voteTimestamp = null;
  }
  await redis.hset(`jurors:${type}`, { [id]: juror });
  return { ok: true, id, code: juror.code || null };
}

async function handleWithdraw(body) {
  const { id, type } = body;
  if (!id || !type) return { ok: false, error: 'Missing id or type' };
  await redis.hdel(`jurors:${type}`, id);
  return { ok: true };
}

async function handleEdit(body) {
  const { id, name, type } = body;
  if (!id || !name || !type) return { ok: false, error: 'Missing fields' };
  const raw = await redis.hget(`jurors:${type}`, id);
  if (!raw) return { ok: false, error: 'Not found' };
  const juror = typeof raw === 'string' ? JSON.parse(raw) : raw;
  juror.name = name.trim();
  await redis.hset(`jurors:${type}`, { [id]: juror });
  return { ok: true };
}

async function handleDelete(body) {
  const { id, type } = body;
  if (!id || !type) return { ok: false, error: 'Missing fields' };
  await redis.hdel(`jurors:${type}`, id);
  return { ok: true };
}

async function handleList(query) {
  const ip = await getAllJurors('inperson');
  const vt = (await getAllJurors('virtual')).map(j => ({
    id: j.id,
    name: j.name,
    linked: !!j.chatId,
    selected: !!j.selected,
    hasVoted: !!j.vote,
    vote: j.vote,
  }));
  return { ok: true, data: { inperson: ip, virtual: vt } };
}

async function handleSelect(body) {
  const { ids } = body;
  if (!ids || !ids.length) return { ok: false, error: 'No IDs' };
  const results = [];
  for (const id of ids) {
    const raw = await redis.hget('jurors:virtual', id);
    if (!raw) { results.push({ id, sent: false, reason: 'Not found' }); continue; }
    const juror = typeof raw === 'string' ? JSON.parse(raw) : raw;
    juror.selected = true;
    juror.voteToken = genToken();
    await redis.hset('jurors:virtual', { [id]: juror });

    if (!juror.chatId) {
      results.push({ id, name: juror.name, sent: false, reason: 'Telegram not linked' });
      continue;
    }
    const voteUrl = `${BASE_URL}/vote.html?token=${juror.voteToken}`;
    const msg = `⚖️ <b>JURY SUMMONS</b>\n\nYou have been selected for jury service in:\n<b>United States v. Herold et al.</b>\nCase No. 26-CR-FAKE-0001\n\nCast your verdict here:\n${voteUrl}\n\n<i>The only rule is that you must follow the rules.</i>`;
    try {
      await sendTelegram(juror.chatId, msg);
      results.push({ id, name: juror.name, sent: true });
    } catch (e) {
      results.push({ id, name: juror.name, sent: false, reason: e.message });
    }
  }
  return { ok: true, results };
}

async function handleVerify(query) {
  const token = query.token;
  if (!token) return { ok: false, error: 'No token' };
  const all = await getAllJurors('virtual');
  const juror = all.find(j => j.voteToken === token);
  if (!juror) return { ok: false, error: 'Invalid or expired summons token.' };
  return {
    ok: true,
    juror: {
      name: juror.name,
      alreadyVoted: !!juror.vote,
      vote: juror.vote,
    },
  };
}

async function handleVote(body) {
  const { token, vote } = body;
  if (!token || !vote) return { ok: false, error: 'Missing fields' };
  const all = await getAllJurors('virtual');
  const juror = all.find(j => j.voteToken === token);
  if (!juror) return { ok: false, error: 'Invalid token' };
  if (juror.vote) return { ok: false, error: 'Already voted' };
  juror.vote = vote;
  juror.voteTimestamp = new Date().toISOString();
  await redis.hset('jurors:virtual', { [juror.id]: juror });
  return { ok: true };
}

async function handleDecline(body) {
  const { token } = body;
  if (!token) return { ok: false, error: 'Missing token' };
  const all = await getAllJurors('virtual');
  const juror = all.find(j => j.voteToken === token);
  if (!juror) return { ok: false, error: 'Invalid token' };
  juror.selected = false;
  juror.voteToken = null;
  await redis.hset('jurors:virtual', { [juror.id]: juror });
  return { ok: true };
}

async function handleResults() {
  const all = await getAllJurors('virtual');
  const votes = all
    .filter(j => j.vote)
    .map(j => ({ name: j.name, vote: j.vote, timestamp: j.voteTimestamp }));
  return { ok: true, votes };
}

// ── Router ─────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const action = req.query.action;
      if (action === 'list') return res.json(await handleList(req.query));
      if (action === 'results') return res.json(await handleResults());
      if (action === 'verify') return res.json(await handleVerify(req.query));
      return res.json({ ok: false, error: 'Unknown action' });
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { return res.json({ ok: false, error: 'Bad JSON' }); }
      }
      const action = body.action;
      if (action === 'add') return res.json(await handleAdd(body));
      if (action === 'withdraw') return res.json(await handleWithdraw(body));
      if (action === 'edit') return res.json(await handleEdit(body));
      if (action === 'delete') return res.json(await handleDelete(body));
      if (action === 'select') return res.json(await handleSelect(body));
      if (action === 'vote') return res.json(await handleVote(body));
      if (action === 'decline') return res.json(await handleDecline(body));
      return res.json({ ok: false, error: 'Unknown action' });
    }

    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
};

