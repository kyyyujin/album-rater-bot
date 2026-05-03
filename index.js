const express   = require('express');
const multer    = require('multer');
const fetch     = require('node-fetch');
const FormData  = require('form-data');

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

const BOT_TOKEN    = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Rate limit control for pfp changes (max 2/hour)
let lastPfpChange = 0;
const PFP_COOLDOWN_MS = 35 * 60 * 1000; // 35 minutes to be safe

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Change bot pfp to album cover ──
async function changeBotPfp(coverUrl) {
  const now = Date.now();
  if (now - lastPfpChange < PFP_COOLDOWN_MS) {
    console.log('PFP cooldown active, skipping change');
    return;
  }

  try {
    // Download the cover image
    const imgRes = await fetch(coverUrl);
    if (!imgRes.ok) throw new Error('Failed to fetch cover image');
    const buffer = await imgRes.buffer();
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const base64 = buffer.toString('base64');
    const dataUri = `data:${contentType};base64,${base64}`;

    // Update bot pfp
    const discordRes = await fetch('https://discord.com/api/v10/users/@me', {
      method: 'PATCH',
      headers: {
        'Authorization': `Bot ${BOT_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ avatar: dataUri })
    });

    const data = await discordRes.json();
    if (!discordRes.ok) {
      console.error('PFP change failed:', data);
      return;
    }

    lastPfpChange = now;
    console.log('Bot pfp updated successfully');
  } catch(e) {
    console.error('PFP change error:', e.message);
  }
}

// ── Save rating to Supabase ──
async function saveRating(data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/ratings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(data)
  });
  const json = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(json));
  return json;
}

// ── Get ratings from Supabase ──
async function getRatings(user_id) {
  const url = user_id
    ? `${SUPABASE_URL}/rest/v1/ratings?user_id=eq.${encodeURIComponent(user_id)}&order=created_at.desc`
    : `${SUPABASE_URL}/rest/v1/ratings?order=created_at.desc`;

  const res = await fetch(url, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`
    }
  });
  return res.json();
}

// ── POST /post — send to Discord + save to Supabase + change pfp ──
app.post('/post', upload.single('file'), async (req, res) => {
  try {
    const { title, thread_id, user_id, artist, cover_url, tracks, final_score, final_rank, notes } = req.body;
    if (!req.file)  return res.status(400).json({ error: 'No image provided' });
    if (!title)     return res.status(400).json({ error: 'No title provided' });
    if (!thread_id) return res.status(400).json({ error: 'No thread_id provided' });

    // 1. Send to Discord
    const form = new FormData();
    const payload = {
      content: `# ${title}`,
      attachments: [{ id: '0', filename: 'rating.png' }]
    };
    form.append('payload_json', JSON.stringify(payload), { contentType: 'application/json' });
    form.append('files[0]', req.file.buffer, { filename: 'rating.png', contentType: 'image/png' });

    console.log('Posting to thread:', thread_id);
    const discordRes = await fetch(
      `https://discord.com/api/v10/channels/${thread_id}/messages`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bot ${BOT_TOKEN}`, ...form.getHeaders() },
        body: form
      }
    );
    const discordData = await discordRes.json();
    console.log('Discord status:', discordRes.status);
    if (!discordRes.ok) {
      return res.status(500).json({ error: 'Discord API error', details: discordData });
    }

    // 2. Save to Supabase (non-fatal)
    if (user_id) {
      try {
        await saveRating({
          user_id,
          album_title: title,
          artist: artist || null,
          cover_url: cover_url || null,
          tracks: tracks ? JSON.parse(tracks) : null,
          final_score: final_score ? parseFloat(final_score) : null,
          final_rank: final_rank || null,
          notes: notes || null
        });
        console.log('Saved to Supabase for user:', user_id);
      } catch(e) {
        console.error('Supabase save error (non-fatal):', e.message);
      }
    }

    // 3. Change bot pfp to album cover (non-fatal, async)
    if (cover_url) {
      changeBotPfp(cover_url).catch(e => console.error('PFP async error:', e));
    }

    res.json({ ok: true, message: discordData.id });
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /history?user_id=xxx ──
app.get('/history', async (req, res) => {
  try {
    const { user_id } = req.query;
    const data = await getRatings(user_id);
    res.json(data);
  } catch (err) {
    console.error('History error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('Album Rater Bot — OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
                
