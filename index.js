const express  = require('express');
const multer   = require('multer');
const fetch    = require('node-fetch');
const FormData = require('form-data');

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

const BOT_TOKEN = process.env.BOT_TOKEN;
const THREAD_ID = process.env.THREAD_ID;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.post('/post', upload.single('file'), async (req, res) => {
  try {
    const { title } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No image provided' });
    if (!title)    return res.status(400).json({ error: 'No title provided' });

    const form = new FormData();

    const payload = {
      content: `# ${title}`,
      attachments: [{ id: '0', filename: 'rating.png' }]
    };

    form.append('payload_json', JSON.stringify(payload), { contentType: 'application/json' });
    form.append('files[0]', req.file.buffer, { filename: 'rating.png', contentType: 'image/png' });

    console.log('Posting to thread:', THREAD_ID);

    const discordRes = await fetch(
      `https://discord.com/api/v10/channels/${THREAD_ID}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bot ${BOT_TOKEN}`,
          ...form.getHeaders()
        },
        body: form
      }
    );

    const data = await discordRes.json();
    console.log('Discord response status:', discordRes.status);
    console.log('Discord response body:', JSON.stringify(data));

    if (!discordRes.ok) {
      return res.status(500).json({ error: 'Discord API error', details: data });
    }

    res.json({ ok: true, message: data.id });
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('Album Rater Bot — OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
