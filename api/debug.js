module.exports = async function handler(req, res) {
  const vars = Object.keys(process.env)
    .filter(k => k.includes('STORAGE') || k.includes('KV') || k.includes('UPSTASH') || k.includes('REDIS'))
    .map(k => k + '=' + (k.includes('TOKEN') ? '***' : process.env[k].substring(0, 30) + '...'));
  res.json({ env_keys: vars });
};
