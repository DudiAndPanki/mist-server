const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;
const OR_KEY = process.env.OPENROUTER_API_KEY;
const MODEL  = 'meta-llama/llama-3.3-70b-instruct';

// ── MIDDLEWARE ──────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ── RATE LIMIT (1 summary/day per IP, server-side) ─────
const usageMap = new Map();

function getClientIp(req){
  return req.headers['x-forwarded-for']?.split(',')[0].trim()
    || req.socket.remoteAddress
    || 'unknown';
}

function checkLimit(req, res, next){
  const ip    = getClientIp(req);
  const today = new Date().toDateString();
  const entry = usageMap.get(ip);
  if(entry && entry.date === today && entry.count >= 1){
    return res.status(429).json({ error: 'Daily limit reached. Upgrade to Pro for unlimited summaries.' });
  }
  next();
}

function incrementLimit(req){
  const ip    = getClientIp(req);
  const today = new Date().toDateString();
  const entry = usageMap.get(ip);
  if(entry && entry.date === today){
    entry.count++;
  } else {
    usageMap.set(ip, { date: today, count: 1 });
  }
}

// ── SHARED FETCH TO OPENROUTER ──────────────────────────
async function callLlama(messages, max_tokens = 1000){
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${OR_KEY}`,
      'HTTP-Referer':  'https://mist-app.com',
      'X-Title':       'Mist'
    },
    body: JSON.stringify({ model: MODEL, max_tokens, messages })
  });
  const data = await response.json();
  if(!response.ok) throw new Error(data.error?.message || `API error ${response.status}`);
  return data.choices[0].message.content;
}

// ── HEALTH CHECK ────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Mist API Proxy', model: MODEL });
});

// ── SUMMARISE ENDPOINT (free: 1/day) ────────────────────
app.post('/api/summarise', checkLimit, async (req, res) => {
  if(!OR_KEY) return res.status(500).json({ error: 'Server not configured.' });
  try{
    const { prompt } = req.body;
    if(!prompt) return res.status(400).json({ error: 'No prompt provided.' });
    const content = await callLlama([{ role: 'user', content: prompt }], 1000);
    incrementLimit(req);
    res.json({ content });
  } catch(err){
    console.error('Summarise error:', err.message);
    res.status(500).json({ error: err.message || 'Something went wrong.' });
  }
});

// ── CHAT ENDPOINT ────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  if(!OR_KEY) return res.status(500).json({ error: 'Server not configured.' });
  try{
    const { messages, system } = req.body;
    const msgs = system
      ? [{ role: 'system', content: system }, ...(messages || [])]
      : (messages || []);
    const content = await callLlama(msgs, 8192);
    res.json({ content });
  } catch(err){
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message || 'Something went wrong.' });
  }
});

// ── START ───────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Mist proxy running on port ${PORT} — model: ${MODEL}`);
});
