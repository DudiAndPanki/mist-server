const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;
const GROQ_KEY = process.env.GROQ_API_KEY;

// ── MIDDLEWARE ──────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ── RATE LIMIT (1 summary/day per IP, server-side) ─────
const usageMap = new Map(); // ip → { date, count }

function getClientIp(req){
  return req.headers['x-forwarded-for']?.split(',')[0].trim()
    || req.socket.remoteAddress
    || 'unknown';
}

function checkLimit(req, res, next){
  if(req.body?.bypass_limit) return next(); // Pro users skip (checked below)
  const ip   = getClientIp(req);
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

// ── HEALTH CHECK ────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Mist API Proxy' });
});

// ── CHAT ENDPOINT (Pro only — no daily limit) ───────────
app.post('/api/chat', async (req, res) => {
  if(!GROQ_KEY){
    return res.status(500).json({ error: 'Server not configured.' });
  }
  try{
    const { messages, system, max_tokens } = req.body;
    const msgs = system
      ? [{ role: 'system', content: system }, ...(messages || [])]
      : (messages || []);

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify({
        model:      'llama-3.1-70b-versatile',
        max_tokens: max_tokens || 8192,
        messages:   msgs
      })
    });

    const data = await response.json();
    if(!response.ok) return res.status(response.status).json(data);
    res.json({ content: data.choices[0].message.content });

  } catch(err){
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ── SUMMARISE ENDPOINT (free: 1/day, pro: unlimited) ────
app.post('/api/summarise', checkLimit, async (req, res) => {
  if(!GROQ_KEY){
    return res.status(500).json({ error: 'Server not configured.' });
  }
  try{
    const { prompt } = req.body;
    if(!prompt) return res.status(400).json({ error: 'No prompt provided.' });

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify({
        model:      'llama-3.1-70b-versatile',
        max_tokens: 1000,
        messages:   [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if(!response.ok) return res.status(response.status).json(data);

    incrementLimit(req); // only count successful summaries
    res.json({ content: data.choices[0].message.content });

  } catch(err){
    console.error('Summarise error:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ── START ───────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Mist proxy running on port ${PORT}`);
});
