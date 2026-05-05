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
    form.append('payload_json', JSON.stringify({ content: `# ${title}`, attachments: [{ id: '0', filename: 'rating.png' }] }), { contentType: 'application/json' });
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

app.get('/', (req, res) => res.send('Album Rater Bot — OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

      
