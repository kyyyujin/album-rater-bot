const express   = require('express');
const multer    = require('multer');
const fetch     = require('node-fetch');
const FormData  = require('form-data');
const sharp     = require('sharp');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

const BOT_TOKEN    = process.env.BOT_TOKEN;
const CLIENT_ID    = process.env.CLIENT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// ── Discord OAuth (login web, distinto del bot de gateway) ──
// CLIENT_ID se reutiliza (es la misma app de Discord que ya tenés).
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET; // Nuevo: sacalo de Discord Developer Portal → OAuth2
const DISCORD_REDIRECT_URI  = process.env.DISCORD_REDIRECT_URI;  // Nuevo: ej. https://album-rater-bot.onrender.com/auth/discord/callback
                                                                   // Debe estar registrada tal cual en Discord Developer Portal → OAuth2 → Redirects
const oauthStates = {}; // state (random) -> { returnTo, expires }  — anti-CSRF + para saber a qué página volver (Rater o Vault)
const pendingDiscordProfiles = {}; // pendingToken -> { discordId, discordUsername, discordAvatar, expires } — cuenta de Discord sin match automático, esperando que el usuario confirme si tiene cuenta vieja

// ── Register slash commands ──
const commands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Comprueba si el bot está activo'),

  new SlashCommandBuilder()
    .setName('historial')
    .setDescription('Muestra tus últimos ratings')
    .addStringOption(opt =>
      opt.setName('usuario')
        .setDescription('Nombre de usuario (default: el tuyo)')
        .setRequired(false))
    .addIntegerOption(opt =>
      opt.setName('cantidad')
        .setDescription('Cuántos mostrar (máx 10, default 5)')
        .setMinValue(1).setMaxValue(10).setRequired(false)),

  new SlashCommandBuilder()
    .setName('top')
    .setDescription('Álbumes mejor rankeados')
    .addStringOption(opt =>
      opt.setName('usuario')
        .setDescription('Nombre de usuario (default: el tuyo)')
        .setRequired(false))
    .addIntegerOption(opt =>
      opt.setName('cantidad')
        .setDescription('Cuántos mostrar (máx 10, default 5)')
        .setMinValue(1).setMaxValue(10).setRequired(false)),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Estadísticas generales de ratings')
    .addStringOption(opt =>
      opt.setName('usuario')
        .setDescription('Nombre de usuario (default: el tuyo)')
        .setRequired(false)),
].map(c => c.toJSON());

async function registerCommands() {
  try {
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Slash commands registered');
  } catch(e) {
    console.error('Failed to register commands:', e.message);
  }
}

// ── Supabase helpers ──
async function getRatings(user_id, limit = null) {
  let url = `${SUPABASE_URL}/rest/v1/ratings?user_id=eq.${encodeURIComponent(user_id)}&order=created_at.desc`;
  if (limit) url += `&limit=${limit}`;
  const res = await fetch(url, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  return res.json();
}

async function saveRating(data) {
  // First check if rating already exists for this user+album
  const checkRes = await fetch(
    `${SUPABASE_URL}/rest/v1/ratings?user_id=eq.${encodeURIComponent(data.user_id)}&album_title=eq.${encodeURIComponent(data.album_title)}&select=id`,
    {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    }
  );
  const existing = await checkRes.json();

  if (existing.length > 0) {
    // Update existing record
    const id = existing[0].id;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/ratings?id=eq.${id}`, {
      method: 'PATCH',
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
  } else {
    // Insert new record
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
}

// ── Rank color helper ──
function rankToColor(rank) {
  if (!rank) return 0x888888;
  if (rank.startsWith('S')) return 0x60d4f0;
  if (rank.startsWith('A')) return 0xc8f060;
  if (rank.startsWith('B')) return 0xf0c860;
  if (rank.startsWith('C')) return 0xf09060;
  return 0xff6060;
}

// ── Discord gateway client ──
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`Bot online: ${client.user.tag}`);
  client.user.setActivity('rateando álbumes 🎵', { type: 3 }); // WATCHING
  await registerCommands();
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const discordUsername = interaction.user.username;

  if (interaction.commandName === 'ping') {
    await interaction.reply({ content: '🎵 Album Rater Bot activo y funcionando!', ephemeral: true });
    return;
  }

  await interaction.deferReply();

  if (interaction.commandName === 'historial') {
    const usuario  = interaction.options.getString('usuario') || discordUsername;
    const cantidad = interaction.options.getInteger('cantidad') || 5;
    try {
      const ratings = await getRatings(usuario, cantidad);
      if (!ratings.length) {
        await interaction.editReply('No tenés ratings guardados todavía.');
        return;
      }
      const embed = new EmbedBuilder()
        .setTitle(`📚 Historial de ${usuario}`)
        .setColor(0x5865f2)
        .setDescription(ratings.map((r, i) =>
          `**${i+1}.** ${r.album_title}${r.artist ? ` — ${r.artist}` : ''}\n` +
          `\`${r.final_score || '—'}\` **[${r.final_rank || '—'}]** · ${new Date(r.created_at).toLocaleDateString('es')}`
        ).join('\n\n'))
        .setFooter({ text: `Últimos ${ratings.length} ratings` });
      await interaction.editReply({ embeds: [embed] });
    } catch(e) {
      await interaction.editReply('Error al obtener el historial.');
    }
    return;
  }

  if (interaction.commandName === 'top') {
    const usuario  = interaction.options.getString('usuario') || discordUsername;
    const cantidad = interaction.options.getInteger('cantidad') || 5;
    try {
      const all = await getRatings(usuario);
      if (!all.length) {
        await interaction.editReply('No tenés ratings guardados todavía.');
        return;
      }
      const sorted = all
        .filter(r => r.final_score !== null)
        .sort((a, b) => parseFloat(b.final_score) - parseFloat(a.final_score))
        .slice(0, cantidad);

      const embed = new EmbedBuilder()
        .setTitle(`🏆 Top ${sorted.length} de ${usuario}`)
        .setColor(0xc8f060)
        .setDescription(sorted.map((r, i) => {
          const medals = ['🥇','🥈','🥉'];
          const prefix = medals[i] || `**${i+1}.**`;
          return `${prefix} ${r.album_title}${r.artist ? ` — ${r.artist}` : ''}\n` +
                 `\`${parseFloat(r.final_score).toFixed(2)}\` **[${r.final_rank || '—'}]**`;
        }).join('\n\n'));
      await interaction.editReply({ embeds: [embed] });
    } catch(e) {
      await interaction.editReply('Error al obtener el top.');
    }
    return;
  }

  if (interaction.commandName === 'stats') {
    const usuario = interaction.options.getString('usuario') || discordUsername;
    try {
      const all = await getRatings(usuario);
      if (!all.length) {
        await interaction.editReply('No tenés ratings guardados todavía.');
        return;
      }
      const scores = all.map(r => parseFloat(r.final_score)).filter(s => !isNaN(s));
      const avg    = scores.reduce((a, b) => a + b, 0) / scores.length;
      const best   = all.filter(r => r.final_score !== null).sort((a,b) => parseFloat(b.final_score) - parseFloat(a.final_score))[0];
      const worst  = all.filter(r => r.final_score !== null).sort((a,b) => parseFloat(a.final_score) - parseFloat(b.final_score))[0];

      // Rank distribution
      const rankCount = {};
      all.forEach(r => { if (r.final_rank) rankCount[r.final_rank] = (rankCount[r.final_rank] || 0) + 1; });
      const rankStr = Object.entries(rankCount)
        .sort((a,b) => b[1] - a[1])
        .map(([rank, count]) => `**${rank}** × ${count}`)
        .join('  ·  ');

      const embed = new EmbedBuilder()
        .setTitle(`📊 Stats de ${usuario}`)
        .setColor(0x5865f2)
        .addFields(
          { name: '🎵 Total rateados', value: `${all.length} álbumes`, inline: true },
          { name: '⭐ Promedio general', value: `\`${avg.toFixed(2)}\``, inline: true },
          { name: '\u200b', value: '\u200b', inline: true },
          { name: '🏆 Mejor', value: `${best.album_title}\n\`${parseFloat(best.final_score).toFixed(2)}\` [${best.final_rank}]`, inline: true },
          { name: '💀 Peor', value: `${worst.album_title}\n\`${parseFloat(worst.final_score).toFixed(2)}\` [${worst.final_rank}]`, inline: true },
          { name: '\u200b', value: '\u200b', inline: true },
          { name: '📈 Distribución de ranks', value: rankStr || '—' }
        );
      await interaction.editReply({ embeds: [embed] });
    } catch(e) {
      await interaction.editReply('Error al obtener las stats.');
    }
    return;
  }
});

client.login(BOT_TOKEN);

// Rate limit for pfp
let lastPfpChange = 0;
const PFP_COOLDOWN_MS = 35 * 60 * 1000;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

async function changeBotPfp(coverUrl) {
  const now = Date.now();
  if (now - lastPfpChange < PFP_COOLDOWN_MS) { console.log('PFP cooldown'); return; }
  try {
    const imgRes = await fetch(coverUrl);
    if (!imgRes.ok) throw new Error('Failed to fetch cover');
    const buffer = await imgRes.buffer();
    const processed = await sharp(buffer).resize(512, 512, { fit: 'cover' }).png().toBuffer();
    await client.user.setAvatar(processed);
    lastPfpChange = now;
    console.log('Bot pfp updated');
  } catch(e) { console.error('PFP error:', e.message); }
}

app.post('/post', upload.single('file'), async (req, res) => {
  try {
    const { title, thread_id, user_id, artist, cover_url, tracks, final_score, final_rank, notes } = req.body;
    if (!req.file)  return res.status(400).json({ error: 'No image provided' });
    if (!title)     return res.status(400).json({ error: 'No title provided' });
    if (!thread_id) return res.status(400).json({ error: 'No thread_id provided' });

    const form = new FormData();
    form.append('payload_json', JSON.stringify({ attachments: [{ id: '0', filename: 'rating.png' }] }), { contentType: 'application/json' });
    form.append('files[0]', req.file.buffer, { filename: 'rating.png', contentType: 'image/png' });

    const discordRes = await fetch(`https://discord.com/api/v10/channels/${thread_id}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bot ${BOT_TOKEN}`, ...form.getHeaders() },
      body: form
    });
    const discordData = await discordRes.json();
    if (!discordRes.ok) return res.status(500).json({ error: 'Discord API error', details: discordData });

    if (user_id) {
      try {
        const cleanTitle = req.body.album_title || title;
        await saveRating({
          user_id,
          album_title: cleanTitle,
          artist:      artist      || null,
          cover_url:   cover_url   || null,
          year:        req.body.year  || null,
          genre:       req.body.genre || null,
          tracks:      tracks ? JSON.parse(tracks) : null,
          final_score: final_score ? parseFloat(final_score) : null,
          final_rank:  final_rank  || null,
          notes:       notes       || null
        });
      } catch(e) { console.error('Supabase error:', e.message); }
    }

    if (cover_url) changeBotPfp(cover_url).catch(console.error);

    res.json({ ok: true, message: discordData.id });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/delete', express.json(), async (req, res) => {
  try {
    const { id, user_id } = req.body;
    if (!id)      return res.status(400).json({ error: 'No id provided' });
    if (!user_id) return res.status(400).json({ error: 'No user_id provided' });

    // Only allow deleting own records
    const delRes = await fetch(`${SUPABASE_URL}/rest/v1/ratings?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(user_id)}`, {
      method: 'DELETE',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=representation'
      }
    });
    if (!delRes.ok) {
      const err = await delRes.json();
      return res.status(500).json({ error: 'Supabase error', details: err });
    }
    res.json({ ok: true });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/save', upload.single('file'), async (req, res) => {
  try {
    const { title, user_id, artist, cover_url, tracks, final_score, final_rank, notes } = req.body;
    if (!req.file)  return res.status(400).json({ error: 'No image provided' });
    if (!title)     return res.status(400).json({ error: 'No title provided' });
    if (!user_id)   return res.status(400).json({ error: 'No user_id provided' });

    const cleanTitle = req.body.album_title || title;
    await saveRating({
      user_id,
      album_title: cleanTitle,
      artist:      artist      || null,
      cover_url:   cover_url   || null,
      year:        req.body.year  || null,
      genre:       req.body.genre || null,
      tracks:      tracks ? JSON.parse(tracks) : null,
      final_score: final_score ? parseFloat(final_score) : null,
      final_rank:  final_rank  || null,
      notes:       notes       || null
    });

    res.json({ ok: true });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/history', async (req, res) => {
  try {
    const data = await getRatings(req.query.user_id);
    res.json(data);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Spotify streams: save (upsert) ──
// ── Spotify streams: save chunks directly to Supabase ──
app.post('/spotify-save', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const { user_id, streams, chunk, total_chunks } = req.body;
    if (!user_id) return res.status(400).json({ error: 'No user_id provided' });
    if (!streams) return res.status(400).json({ error: 'No streams provided' });

    const chunkIndex = chunk ?? 0;
    console.log(`[spotify-save] user=${user_id} chunk=${chunkIndex} total=${total_chunks ?? 1} streams=${Array.isArray(streams) ? streams.length : '?'}`);

    // If this is the first chunk, delete old data first
    if (chunkIndex === 0) {
      await fetch(`${SUPABASE_URL}/rest/v1/spotify_streams?user_id=eq.${encodeURIComponent(user_id)}`, {
        method: 'DELETE',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      console.log(`[spotify-save] cleared old data for ${user_id}`);
    }

    // Save this chunk as its own row
    const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/spotify_streams`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify({
        user_id,
        chunk_index: chunkIndex,
        streams,
        updated_at: new Date().toISOString()
      })
    });

    const rawText = await upsertRes.text();
    console.log(`[spotify-save] Supabase status=${upsertRes.status}`);

    if (!upsertRes.ok) {
      return res.status(500).json({ error: 'Supabase error', status: upsertRes.status, body: rawText.slice(0, 300) });
    }
    res.json({ ok: true });
  } catch(err) {
    console.error('[spotify-save] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Spotify streams: load all chunks and merge ──
app.get('/spotify-load', async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: 'No user_id provided' });

    const loadRes = await fetch(
      `${SUPABASE_URL}/rest/v1/spotify_streams?user_id=eq.${encodeURIComponent(user_id)}&order=chunk_index.asc`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const data = await loadRes.json();
    if (!data.length) return res.json({ streams: null });

    // Merge all chunks
    const allStreams = data.flatMap(row => row.streams);
    console.log(`[spotify-load] user=${user_id} chunks=${data.length} total=${allStreams.length}`);
    res.json({ streams: allStreams });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: clean duplicate ratings (keep latest per user+album) ──
app.post('/clean-duplicates', express.json(), async (req, res) => {
  try {
    const { requester } = req.body;
    if (requester?.toLowerCase() !== 'kyujin') return res.status(403).json({ error: 'Forbidden' });

    const allRes = await fetch(`${SUPABASE_URL}/rest/v1/ratings?select=id,user_id,album_title,created_at&order=created_at.desc`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const all = await allRes.json();

    const seen = new Set();
    const toDelete = [];
    all.forEach(r => {
      const key = `${r.user_id}|${r.album_title}`;
      if (seen.has(key)) {
        toDelete.push(r.id);
      } else {
        seen.add(key);
      }
    });

    for (const id of toDelete) {
      await fetch(`${SUPABASE_URL}/rest/v1/ratings?id=eq.${id}`, {
        method: 'DELETE',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
    }

    res.json({ ok: true, deleted: toDelete.length });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Update rating directly (no image needed) ──
app.post('/update-rating', express.json(), async (req, res) => {
  try {
    const { user_id, album_title, artist, year, genre, cover_url, final_score, final_rank, tracks } = req.body;
    if (!user_id || !album_title) return res.status(400).json({ error: 'Faltan datos' });
    const data = { user_id, album_title, artist, year, genre, cover_url, final_score, final_rank, tracks };
    const result = await saveRating(data);
    res.json({ ok: true, result });
  } catch(err) {
    console.error('[update-rating]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Public: random covers for login bg ──
app.get('/covers', async (req, res) => {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/ratings?select=cover_url&limit=200&order=created_at.desc`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const data = await r.json();
    const covers = [...new Set(data.map(row => row.cover_url).filter(Boolean))];
    const shuffled = covers.sort(() => Math.random() - 0.5).slice(0, 40);
    res.json({ covers: shuffled });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: list all users ──
app.get('/users', async (req, res) => {
  try {
    const { requester } = req.query;
    if (requester?.toLowerCase() !== 'kyujin') return res.status(403).json({ error: 'Forbidden' });
    const r = await fetch(`${SUPABASE_URL}/rest/v1/ratings?select=user_id&order=user_id.asc`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const data = await r.json();
    const users = [...new Set(data.map(row => row.user_id))].sort();
    res.json({ users });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin: delete any user's rating ──
app.post('/admin-delete', express.json(), async (req, res) => {
  try {
    const { id, target_user_id, requester } = req.body;
    if (requester?.toLowerCase() !== 'kyujin') return res.status(403).json({ error: 'Forbidden' });
    if (!id || !target_user_id) return res.status(400).json({ error: 'Missing id or target_user_id' });
    const delRes = await fetch(`${SUPABASE_URL}/rest/v1/ratings?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(target_user_id)}`, {
      method: 'DELETE',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=representation' }
    });
    if (!delRes.ok) return res.status(500).json({ error: 'Supabase error' });
    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('Album Rater Bot — OK'));

// ── AUTH ──
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const ADMIN_USER = 'kyujin';

// Las sesiones ahora se persisten en Supabase (tabla "sessions") en vez de
// vivir solo en memoria — así sobreviven a un redeploy/reinicio de Render.
// Requiere en Supabase una tabla nueva:
//   sessions ( token text primary key, username text, created_at timestamptz default now() )
// Sin columna de expiración: la sesión dura indefinidamente hasta logout manual
// (se borra la fila cuando el usuario cierra sesión — ver DELETE /auth/session).
const sessionCache = {}; // token -> username — cache en memoria solo para no pegarle a Supabase en cada request; se repuebla sola si el proceso reinicia

async function generateToken(username) {
  const token = crypto.randomBytes(32).toString('hex');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ token, username })
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`No se pudo crear la sesión: ${err}`); }
  sessionCache[token] = username;
  return token;
}

async function verifyToken(token) {
  if (sessionCache[token]) return sessionCache[token];
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sessions?token=eq.${encodeURIComponent(token)}&limit=1`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  const data = await res.json();
  if (!data[0]) return null;
  sessionCache[token] = data[0].username;
  return data[0].username;
}

async function deleteToken(token) {
  delete sessionCache[token];
  await fetch(`${SUPABASE_URL}/rest/v1/sessions?token=eq.${encodeURIComponent(token)}`, {
    method: 'DELETE',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  }).catch(err => console.error('[deleteToken]', err.message));
}

async function getUser(username) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/users?username=eq.${encodeURIComponent(username)}&limit=1`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  const data = await res.json();
  return data[0] || null;
}
async function createUser(username, passwordHash) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=representation' },
    body: JSON.stringify({ username, password_hash: passwordHash })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data[0];
}

// ── Discord OAuth: helpers ──
// Requiere en Supabase 3 columnas nuevas en la tabla "users" (nullable):
//   discord_id       text  (idealmente con índice/constraint unique)
//   discord_username text
//   discord_avatar   text
async function getUserByDiscordId(discordId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/users?discord_id=eq.${encodeURIComponent(discordId)}&limit=1`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  const data = await res.json();
  return data[0] || null;
}

async function linkDiscordToUser(userRowId, discordId, discordUsername, discordAvatar) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${encodeURIComponent(userRowId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=representation' },
    body: JSON.stringify({ discord_id: discordId, discord_username: discordUsername, discord_avatar: discordAvatar })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data[0];
}

async function createUserFromDiscord(username, discordId, discordUsername, discordAvatar) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=representation' },
    body: JSON.stringify({ username, discord_id: discordId, discord_username: discordUsername, discord_avatar: discordAvatar })
    // password_hash queda null — esta cuenta nace directamente vinculada a Discord
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data[0];
}

// ── Álbum en progreso (work in progress) ──
// Un solo slot por usuario, guardado como jsonb en users.work_in_progress.
// Requiere en Supabase la columna (nullable): users.work_in_progress jsonb
async function saveWorkInProgress(username, wip) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/users?username=eq.${encodeURIComponent(username)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ work_in_progress: wip })
  });
  if (!res.ok) { const err = await res.text(); throw new Error(err); }
}

async function getWorkInProgress(username) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/users?username=eq.${encodeURIComponent(username)}&select=work_in_progress&limit=1`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  const data = await res.json();
  return data[0]?.work_in_progress || null;
}

// ── Colección de Album Vault ──
// Igual que work_in_progress, pero para la colección completa de álbumes en tiers.
// Requiere en Supabase la columna (nullable): users.vault_collection jsonb
async function saveVaultCollection(username, collection) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/users?username=eq.${encodeURIComponent(username)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ vault_collection: collection })
  });
  if (!res.ok) { const err = await res.text(); throw new Error(err); }
}

async function getVaultCollection(username) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/users?username=eq.${encodeURIComponent(username)}&select=vault_collection&limit=1`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  const data = await res.json();
  return data[0]?.vault_collection || null;
}

// ── Perfil de Vault (banner, bio, favoritos elegidos a mano) ──
// Requiere en Supabase la columna (nullable): users.vault_profile jsonb
async function saveVaultProfile(username, profile) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/users?username=eq.${encodeURIComponent(username)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ vault_profile: profile })
  });
  if (!res.ok) { const err = await res.text(); throw new Error(err); }
}

async function getVaultProfile(username) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/users?username=eq.${encodeURIComponent(username)}&select=vault_profile&limit=1`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  const data = await res.json();
  return data[0]?.vault_profile || null;
}

app.post('/register', express.json(), async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Faltan datos' });
    if (username.length < 3) return res.status(400).json({ error: 'Username muy corto (mín 3 caracteres)' });
    if (password.length < 6) return res.status(400).json({ error: 'Contraseña muy corta (mín 6 caracteres)' });
    const existing = await getUser(username);
    if (existing) return res.status(409).json({ error: 'Ese username ya está en uso' });
    const hash = await bcrypt.hash(password, 10);
    await createUser(username, hash);
    const token = await generateToken(username);
    res.json({ ok: true, token, username });
  } catch(err) {
    console.error('[register]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/login', express.json(), async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Faltan datos' });
    const user = await getUser(username);
    if (!user) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    const token = await generateToken(username);
    res.json({ ok: true, token, username });
  } catch(err) {
    console.error('[login]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/verify', express.json(), async (req, res) => {
  try {
    const { token } = req.body;
    const username = await verifyToken(token);
    if (!username) return res.status(401).json({ error: 'Sesión inválida o expirada' });
    res.json({ ok: true, username });
  } catch (err) {
    console.error('[verify]', err.message);
    res.status(500).json({ error: 'Error al verificar sesión' });
  }
});

// Cierre de sesión explícito: borra el token de Supabase (además del logout del frontend, que solo limpia localStorage).
app.post('/auth/logout', express.json(), async (req, res) => {
  const { token } = req.body;
  if (token) await deleteToken(token);
  res.json({ ok: true });
});

// ── Álbum en progreso: guardar / recuperar ──
// Ambos requieren el token de sesión, igual que /verify.
app.post('/work-in-progress', express.json(), async (req, res) => {
  try {
    const { token, wip } = req.body;
    const username = await verifyToken(token);
    if (!username) return res.status(401).json({ error: 'Sesión inválida o expirada' });
    await saveWorkInProgress(username, wip ?? null);
    res.json({ ok: true });
  } catch (err) {
    console.error('[work-in-progress save]', err.message);
    res.status(500).json({ error: 'No se pudo guardar el progreso' });
  }
});

app.post('/work-in-progress/get', express.json(), async (req, res) => {
  try {
    const { token } = req.body;
    const username = await verifyToken(token);
    if (!username) return res.status(401).json({ error: 'Sesión inválida o expirada' });
    const wip = await getWorkInProgress(username);
    res.json({ ok: true, wip });
  } catch (err) {
    console.error('[work-in-progress get]', err.message);
    res.status(500).json({ error: 'No se pudo recuperar el progreso' });
  }
});

// ── Colección de Album Vault: guardar / recuperar ──
// Mismo patrón que /work-in-progress, para la app de Vault (login compartido con Rater).
app.post('/vault-collection', express.json(), async (req, res) => {
  try {
    const { token, collection } = req.body;
    const username = await verifyToken(token);
    if (!username) return res.status(401).json({ error: 'Sesión inválida o expirada' });
    await saveVaultCollection(username, collection ?? null);
    res.json({ ok: true });
  } catch (err) {
    console.error('[vault-collection save]', err.message);
    res.status(500).json({ error: 'No se pudo guardar la colección' });
  }
});

app.post('/vault-collection/get', express.json(), async (req, res) => {
  try {
    const { token } = req.body;
    const username = await verifyToken(token);
    if (!username) return res.status(401).json({ error: 'Sesión inválida o expirada' });
    const collection = await getVaultCollection(username);
    res.json({ ok: true, collection });
  } catch (err) {
    console.error('[vault-collection get]', err.message);
    res.status(500).json({ error: 'No se pudo recuperar la colección' });
  }
});

// ── Perfil de Vault: guardar / recuperar ──
// { banner: dataURL o null, bio: string, pinned: [albumId, ...] }
// El banner viaja como imagen base64; se limita el tamaño del body para no permitir
// imágenes gigantes que infen la fila (el frontend ya redimensiona antes de mandar).
app.post('/vault-profile', express.json({ limit: '4mb' }), async (req, res) => {
  try {
    const { token, profile } = req.body;
    const username = await verifyToken(token);
    if (!username) return res.status(401).json({ error: 'Sesión inválida o expirada' });
    await saveVaultProfile(username, profile ?? null);
    res.json({ ok: true });
  } catch (err) {
    console.error('[vault-profile save]', err.message);
    res.status(500).json({ error: 'No se pudo guardar el perfil' });
  }
});

app.post('/vault-profile/get', express.json(), async (req, res) => {
  try {
    const { token } = req.body;
    const username = await verifyToken(token);
    if (!username) return res.status(401).json({ error: 'Sesión inválida o expirada' });
    const profile = await getVaultProfile(username);
    res.json({ ok: true, profile });
  } catch (err) {
    console.error('[vault-profile get]', err.message);
    res.status(500).json({ error: 'No se pudo recuperar el perfil' });
  }
});

// ── Perfil público de Vault (solo lectura, sin token) ──
// Búsqueda por discord_username (lo que el usuario reconoce y comparte).
// Devuelve solo lo necesario para renderizar el perfil ajeno: nunca password_hash,
// discord_id, ni tokens de sesión.
//
// Nota: puede haber más de una fila en `users` con el mismo discord_username si un
// usuario tuvo una cuenta vieja (username/password) y luego, al vincular Discord,
// no hizo el match automático y terminó creando una cuenta nueva en vez de vincular
// la vieja — quedan dos filas con el mismo discord_username pero distinto `username`
// interno, y solo una de ellas tiene la sesión activa (donde sí se guarda
// vault_collection). Por eso acá se piden todas las coincidencias y se elige la que
// realmente tenga datos, en vez de confiar en cuál devuelve la DB primero.
// ── Búsqueda pública de perfiles (autocompletado del Vault) ──
// Devuelve únicamente nombre y avatar. La coincidencia es parcial y no distingue
// mayúsculas/minúsculas; nunca expone username interno, discord_id ni datos privados.
app.get('/public-profiles/search', async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    if (!query) return res.json({ ok: true, users: [] });
    const pattern = `*${query.replace(/[*,()]/g, '')}*`;
    const url = `${SUPABASE_URL}/rest/v1/users?discord_username=ilike.${encodeURIComponent(pattern)}&select=discord_username,discord_avatar&limit=12`;
    const sbRes = await fetch(url, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const rows = await sbRes.json();
    if (!sbRes.ok || !Array.isArray(rows)) {
      return res.status(500).json({ error: 'No se pudieron buscar usuarios' });
    }

    const seen = new Set();
    const users = rows
      .filter(row => row.discord_username)
      .filter(row => {
        const key = row.discord_username.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 8)
      .map(row => ({
        discord_username: row.discord_username,
        discord_avatar: row.discord_avatar || null
      }));

    res.json({ ok: true, users });
  } catch (err) {
    console.error('[public-profiles search]', err.message);
    res.status(500).json({ error: 'No se pudieron buscar usuarios' });
  }
});

app.get('/public-profile/:discordUsername', async (req, res) => {
  try {
    const discordUsername = req.params.discordUsername;
    if (!discordUsername) return res.status(400).json({ error: 'Falta username' });
    const url = `${SUPABASE_URL}/rest/v1/users?discord_username=ilike.${encodeURIComponent(discordUsername)}&select=username,discord_username,discord_avatar,vault_profile,vault_collection`;
    const sbRes = await fetch(url, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } });
    const matches = await sbRes.json();
    if (!Array.isArray(matches) || !matches.length) return res.status(404).json({ error: 'Usuario no encontrado' });

    // Perfil y colección pueden haber quedado en filas distintas por migraciones
    // antiguas de Discord. Resolver cada bloque por separado evita perder uno al
    // elegir una sola fila como fuente de todos los datos.
    const profileUser = matches.find(u => u.vault_profile) || matches[0];
    const collectionUser = matches.find(u => u.vault_collection) || null;
    let collection = collectionUser?.vault_collection || null;

    // Usuarios que todavía no sincronizaron una colección del Vault sí pueden
    // tener cientos de ratings históricos. En ese caso reconstruimos una colección
    // pública compatible a partir de ratings, buscando user_id sin distinguir
    // mayúsculas/minúsculas (Discord puede mostrar "Pinovic" mientras ratings usa
    // "pinovic"). Esto es solo lectura y no modifica ninguna fila.
    if (!collection) {
      const identifiers = [...new Set(
        [collectionUser?.username, profileUser?.username, profileUser?.discord_username, discordUsername]
          .filter(Boolean)
      )];

      let ratingRows = [];
      for (const identifier of identifiers) {
        const ratingsUrl = `${SUPABASE_URL}/rest/v1/ratings?user_id=ilike.${encodeURIComponent(identifier)}&order=created_at.desc`;
        const ratingsRes = await fetch(ratingsUrl, {
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
        });
        const candidateRows = await ratingsRes.json();
        if (Array.isArray(candidateRows) && candidateRows.length) {
          ratingRows = candidateRows;
          break;
        }
      }

      if (ratingRows.length) {
        collection = {
          nowPlayingId: null,
          albums: ratingRows.map(row => {
            const score = Number.parseFloat(row.final_score) || 0;
            const rawTracks = Array.isArray(row.tracks) ? row.tracks : [];
            return {
              id: `rating_${row.id}`,
              _dbId: row.id,
              title: row.album_title || row.title || '',
              artist: row.artist || '',
              year: row.year || '',
              coverUrl: row.cover_url || '',
              score,
              finalRank: row.final_rank || '',
              tracks: rawTracks.map(track => typeof track === 'string' ? track : track?.name).filter(Boolean),
              trackScores: Object.fromEntries(
                rawTracks
                  .filter(track => track && typeof track === 'object' && track.name && track.score !== '' && track.score != null)
                  .map(track => [track.name.trim(), Number.parseFloat(track.score)])
              ),
              notes: row.notes || '',
              listenDate: row.created_at ? new Date(row.created_at).toISOString().slice(0, 10) : '',
              addedAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
              status: 'listened',
              genres: typeof row.genre === 'string'
                ? row.genre.split(/[,/]/).map(genre => genre.trim()).filter(Boolean)
                : (Array.isArray(row.genre) ? row.genre : []),
              replays: []
            };
          })
        };
        console.log(`[public-profile] colección reconstruida desde ${ratingRows.length} ratings para ${discordUsername}`);
      }
    }

    if (matches.length > 1) {
      console.warn(`[public-profile] ${matches.length} filas duplicadas para discord_username=${discordUsername}`);
    }

    res.json({
      ok: true,
      discord_username: profileUser.discord_username,
      discord_avatar: profileUser.discord_avatar,
      profile: profileUser.vault_profile || null,
      collection
    });
  } catch (err) {
    console.error('[public-profile]', err.message);
    res.status(500).json({ error: 'No se pudo cargar el perfil' });
  }
});

// ── Discord OAuth: login ──
// 1) El frontend pide esta URL y redirige al usuario a Discord.
app.get('/auth/discord/start', (req, res) => {
  const returnTo = req.query.return_to;
  if (!returnTo) return res.status(400).json({ error: 'Falta return_to' });

  const state = crypto.randomBytes(16).toString('hex');
  oauthStates[state] = { returnTo, expires: Date.now() + 1000 * 60 * 10 }; // 10 min

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify',
    state
  });
  res.json({ url: `https://discord.com/api/oauth2/authorize?${params.toString()}` });
});

// 2) Discord redirige acá después de que el usuario autoriza.
//    Intercambiamos el code, buscamos/creamos/vinculamos el usuario, y volvemos al frontend con la sesión.
app.get('/auth/discord/callback', async (req, res) => {
  const { code, state, error: discordError } = req.query;

  const stateEntry = state && oauthStates[state];
  if (stateEntry) delete oauthStates[state]; // one-time use
  const returnTo = (stateEntry && stateEntry.returnTo) || null;

  function redirectWithError(message) {
    if (!returnTo) return res.status(400).send(message);
    const url = new URL(returnTo);
    url.searchParams.set('auth_error', encodeURIComponent(message));
    res.redirect(url.toString());
  }

  if (discordError) return redirectWithError('Autorización de Discord cancelada');
  if (!code) return redirectWithError('Falta el código de Discord');
  if (!stateEntry || Date.now() > stateEntry.expires) return redirectWithError('Sesión de login expirada, intentá de nuevo');

  try {
    // Canjear code por access_token
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: DISCORD_REDIRECT_URI
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error('[discord oauth] token exchange failed:', tokenData);
      return redirectWithError('No se pudo validar con Discord');
    }

    // Obtener perfil del usuario
    const profileRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const profile = await profileRes.json();
    if (!profileRes.ok) return redirectWithError('No se pudo obtener el perfil de Discord');

    const discordId       = profile.id;
    const discordUsername = profile.username;
    const discordAvatar   = profile.avatar
      ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png?size=256`
      : `https://cdn.discordapp.com/embed/avatars/${(BigInt(profile.id) >> 22n) % 6n}.png`; // avatar default de Discord si no tiene uno

    // 1) ¿Ya existe una cuenta vinculada a este discord_id?
    let user = await getUserByDiscordId(discordId);

    // 2) Si no existe, buscar una cuenta VIEJA con username == discordUsername y vincularla (migración automática).
    if (!user) {
      const legacyUser = await getUser(discordUsername);
      if (legacyUser && !legacyUser.discord_id) {
        user = await linkDiscordToUser(legacyUser.id, discordId, discordUsername, discordAvatar);
      }
    }

    // 3) Si el nombre de Discord no coincide con ninguna cuenta vieja, no creamos nada todavía:
    //    guardamos el perfil de Discord temporalmente y le devolvemos el control al frontend
    //    para que le pregunte al usuario si tiene una cuenta anterior con otro nombre.
    if (!user) {
      const pendingToken = crypto.randomBytes(16).toString('hex');
      pendingDiscordProfiles[pendingToken] = { discordId, discordUsername, discordAvatar, expires: Date.now() + 1000 * 60 * 10 };

      const url = new URL(returnTo);
      url.searchParams.set('discord_pending', pendingToken);
      url.searchParams.set('discord_username', discordUsername);
      url.searchParams.set('discord_avatar', discordAvatar);
      return res.redirect(url.toString());
    }

    // 4) Mantener discord_username/avatar frescos si cambiaron en Discord desde la última vez.
    if (user.discord_username !== discordUsername || user.discord_avatar !== discordAvatar) {
      user = await linkDiscordToUser(user.id, discordId, discordUsername, discordAvatar);
    }

    const appToken = await generateToken(user.username);

    const url = new URL(returnTo);
    url.searchParams.set('auth_token', appToken);
    url.searchParams.set('discord_user_id', user.username); // se mantiene como identificador interno (user_id de ratings, etc.)
    url.searchParams.set('discord_username', discordUsername);
    url.searchParams.set('discord_avatar', discordAvatar);
    res.redirect(url.toString());
  } catch (err) {
    console.error('[discord oauth] error:', err.message);
    redirectWithError('Error interno al conectar con Discord');
  }
});

// 3) El frontend, cuando no hubo auto-match, muestra un formulario y llama acá con:
//      - pending_token (el discord_pending que recibió)
//      - legacy_username (si el usuario dice "sí, tengo cuenta vieja, se llama X") — opcional
//    Si no manda legacy_username, se crea una cuenta nueva vinculada directo a Discord.
app.post('/auth/discord/finish', express.json(), async (req, res) => {
  try {
    const { pending_token, legacy_username } = req.body;
    const pending = pending_token && pendingDiscordProfiles[pending_token];
    if (!pending || Date.now() > pending.expires) {
      return res.status(400).json({ error: 'Esa sesión de Discord expiró, volvé a intentar el login' });
    }
    delete pendingDiscordProfiles[pending_token]; // one-time use

    const { discordId, discordUsername, discordAvatar } = pending;
    let user;

    if (legacy_username && legacy_username.trim()) {
      const legacyUser = await getUser(legacy_username.trim());
      if (!legacyUser) return res.status(404).json({ error: 'No existe ninguna cuenta con ese nombre' });
      if (legacyUser.discord_id) return res.status(409).json({ error: 'Esa cuenta ya está vinculada a otro Discord' });
      user = await linkDiscordToUser(legacyUser.id, discordId, discordUsername, discordAvatar);
    } else {
      user = await createUserFromDiscord(discordUsername, discordId, discordUsername, discordAvatar);
    }

    const appToken = await generateToken(user.username);
    res.json({ ok: true, token: appToken, username: user.username, discord_username: discordUsername, discord_avatar: discordAvatar });
  } catch (err) {
    console.error('[discord oauth finish] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

      
