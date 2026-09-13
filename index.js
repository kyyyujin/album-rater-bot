const express   = require('express');
const multer    = require('multer');
const fetch     = require('node-fetch');
const FormData  = require('form-data');
const sharp     = require('sharp');
const puppeteer = require('puppeteer');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const AchievementRules = require('./achievement-rules');

const app    = express();
// Render's small instances are memory constrained. libvips must not retain a
// cache or fan out workers while Chromium is also used by the export route.
sharp.cache(false);
sharp.concurrency(1);
// Las imágenes de Discord se procesan en memoria; un límite explícito evita que
// una subida anómala lleve el proceso de Render al límite antes de ser rechazada.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 24, fieldSize: 512 * 1024, parts: 28 }
});

const BOT_TOKEN    = process.env.BOT_TOKEN;
const CLIENT_ID    = process.env.CLIENT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// ── Discord OAuth (login web, distinto del bot de gateway) ──
// CLIENT_ID se reutiliza (es la misma app de Discord que ya tenés).
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET; // Nuevo: sacalo de Discord Developer Portal → OAuth2
const DISCORD_REDIRECT_URI  = process.env.DISCORD_REDIRECT_URI;  // Nuevo: ej. https://album-rater-bot.onrender.com/auth/discord/callback
                                                                   // Debe estar registrada tal cual en Discord Developer Portal → OAuth2 → Redirects
// El Rater está temporalmente reservado para la cuenta propietaria. Vault sigue usando el login compartido sin esta restricción.
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
  res.header('Access-Control-Expose-Headers', 'X-Rating-Renderer, X-Rating-Image-Width, X-Rating-Export-Revision');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Pixel-faithful rating export ──
// A real Chromium compositor paints the same DOM/CSS used by the visible preview.
// Chromium is intentionally on-demand: retaining it after a render exhausted
// the memory allowance of the Render instance.
let ratingExportBusy = false;
const ratingExportRateLimits = new Map();

function launchRatingExportBrowser() {
  return puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--metrics-recording-only',
      '--mute-audio',
      '--font-render-hinting=medium'
    ]
  });
}

function isPrivateRenderHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local')) return true;
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  const match = host.match(/^172\.(\d{1,3})\./);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function allowRatingExportRequest(url) {
  if (url === 'about:blank' || url.startsWith('data:')) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !isPrivateRenderHost(parsed.hostname);
  } catch (_) {
    return false;
  }
}

function escapeHtmlAttribute(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// Shared contract with Rater-Page. A split deploy must fail clearly instead of
// silently producing a card with an older renderer.
const RATING_EXPORT_REVISION = 'rater-export-20260913.2';
const MUSIC_IDENTITY_REVISION = 'phase15-musicbrainz-release-groups.4';
app.get('/render-rating/health', (_req, res) => {
  try {
    // executablePath validates that Puppeteer resolved the installed browser
    // without launching a resident Chromium process just for a health check.
    const executablePath = puppeteer.executablePath();
    res.json({
      ok: Boolean(executablePath),
      renderer: 'chromium',
      revision: RATING_EXPORT_REVISION,
      music_identity_revision: MUSIC_IDENTITY_REVISION,
      mode: 'on-demand',
      busy: ratingExportBusy
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      renderer: 'chromium',
      revision: RATING_EXPORT_REVISION,
      error: String(error && error.message ? error.message : error).slice(0, 800)
    });
  }
});

// The master rating export is intentionally desktop-only. A phone can request
// it, but its viewport must never change the visual composition sent to Discord
// or downloaded as PNG.
const RATING_EXPORT_VIEWPORT_WIDTH = 1440;
const RATING_EXPORT_VIEWPORT_HEIGHT = 2600;
const RATING_EXPORT_CARD_WIDTH = 1280;
const RATING_EXPORT_IMAGE_WIDTH = 1920;

app.post('/render-rating', express.json({ limit: '3mb' }), async (req, res) => {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const recent = (ratingExportRateLimits.get(ip) || []).filter(time => now - time < 60_000);
  if (recent.length >= 10) return res.status(429).json({ error: 'Demasiadas exportaciones; espera un minuto.' });
  recent.push(now);
  ratingExportRateLimits.set(ip, recent);

  if (ratingExportBusy) {
    res.set('Retry-After', '8');
    return res.status(503).json({ error: 'El renderer está terminando otra exportación. Intenta nuevamente en unos segundos.' });
  }
  ratingExportBusy = true;

  let browser = null;
  let page = null;
  try {
    const { token, cardHtml, cssText, fontUrls } = req.body || {};
    const username = await verifyTokenFromStore(token);
    if (!username) return res.status(401).json({ error: 'Sesión inválida o expirada' });

    if (typeof cardHtml !== 'string' || !cardHtml.includes('out-card') || cardHtml.length > 900_000) {
      return res.status(400).json({ error: 'Preview inválida' });
    }
    if (typeof cssText !== 'string' || cssText.length > 1_500_000) {
      return res.status(400).json({ error: 'Estilos inválidos' });
    }
    if (/<\/?(?:script|iframe|object|embed|link|meta|base)\b/i.test(cardHtml) || /\son[a-z]+\s*=/i.test(cardHtml)) {
      return res.status(400).json({ error: 'Contenido no permitido en la preview' });
    }

    const safeViewportWidth = RATING_EXPORT_VIEWPORT_WIDTH;
    const safeViewportHeight = RATING_EXPORT_VIEWPORT_HEIGHT;
    const safeCardWidth = RATING_EXPORT_CARD_WIDTH;
    const deviceScaleFactor = Math.max(1.5, Math.min(4, RATING_EXPORT_IMAGE_WIDTH / safeCardWidth));
    const safeFonts = Array.isArray(fontUrls)
      ? fontUrls.filter(url => /^https:\/\/fonts\.googleapis\.com\//i.test(String(url))).slice(0, 4)
      : [];

    browser = await launchRatingExportBrowser();
    page = await browser.newPage();
    await page.setViewport({
      width: safeViewportWidth,
      height: safeViewportHeight,
      deviceScaleFactor
    });
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (allowRatingExportRequest(request.url())) request.continue();
      else request.abort('blockedbyclient');
    });

    const fontLinks = safeFonts.map(url => `<link rel="stylesheet" href="${escapeHtmlAttribute(url)}">`).join('');
    const documentHtml = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src data: https://fonts.gstatic.com; connect-src 'none'; script-src 'none'; object-src 'none';">
${fontLinks}
<style>${cssText}</style>
<style>
  html,body{margin:0!important;padding:0!important;width:${safeViewportWidth}px!important;height:auto!important;min-height:0!important;overflow:visible!important;background:transparent!important;}
  body{display:block!important;}
  #rating-capture-root{display:flow-root;width:${safeCardWidth}px;height:auto;min-height:0;margin:0;padding:0;overflow:visible;}
  #rating-capture-root>.out-card{display:block;width:100%!important;height:auto!important;min-height:0!important;margin:0!important;}
</style>
</head>
<body><main id="rating-capture-root">${cardHtml}</main></body>
</html>`;

    await page.setContent(documentHtml, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForNetworkIdle({ idleTime: 350, timeout: 10_000 }).catch(() => {});
    await page.evaluate(async () => {
      if (document.fonts?.ready) await document.fonts.ready;
      await Promise.all(Array.from(document.images).map(async image => {
        if (image.complete) {
          try { await image.decode(); } catch (_) {}
          return;
        }
        await new Promise(resolve => {
          const done = () => resolve();
          image.addEventListener('load', done, { once: true });
          image.addEventListener('error', done, { once: true });
          setTimeout(done, 8_000);
        });
      }));
      await new Promise(resolve => setTimeout(resolve, 650));
    });

    const card = await page.$('#rating-capture-root > .out-card');
    if (!card) throw new Error('Chromium no encontró la preview');
    const box = await card.boundingBox();
    if (!box || box.width < 1 || box.height < 1 || box.height > 5000) {
      throw new Error('Dimensiones de preview inválidas');
    }

    let png = Buffer.from(await card.screenshot({
      type: 'png',
      omitBackground: true,
      captureBeyondViewport: true
    }));

    // Free Chromium before any optional PNG recompression and before the
    // client uploads the image back through /post. This is the critical peak-
    // memory boundary on Render.
    await page.close();
    page = null;
    await browser.close();
    browser = null;

    // Chrome already paints 1280 CSS px at 1.5 DPR = 1920 output px. Only
    // recompress unusually large files, after Chromium has been released.
    if (png.length > 7 * 1024 * 1024) {
      png = await sharp(png)
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer();
    }

    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    res.set('X-Rating-Renderer', 'chromium');
    res.set('X-Rating-Image-Width', String(RATING_EXPORT_IMAGE_WIDTH));
    res.set('X-Rating-Export-Revision', RATING_EXPORT_REVISION);
    res.send(png);
  } catch (error) {
    console.error('[render-rating]', error);
    res.status(500).json({ error: 'No se pudo renderizar la exportación con Chromium' });
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) {
      await browser.close().catch(() => {
        try { browser.process()?.kill('SIGKILL'); } catch (_) {}
      });
    }
    ratingExportBusy = false;
  }
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
    const { title, thread_id, user_id, artist, cover_url, cover_score, tracks, final_score, final_rank, notes } = req.body;
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
          cover_score: cover_score !== undefined && cover_score !== '' ? parseFloat(cover_score) : null,
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
    const { title, user_id, artist, cover_url, cover_score, tracks, final_score, final_rank, notes } = req.body;
    if (!title)     return res.status(400).json({ error: 'No title provided' });
    if (!user_id)   return res.status(400).json({ error: 'No user_id provided' });

    const cleanTitle = req.body.album_title || title;
    await saveRating({
      user_id,
      album_title: cleanTitle,
      artist:      artist      || null,
      cover_url:   cover_url   || null,
      cover_score: cover_score !== undefined && cover_score !== '' ? parseFloat(cover_score) : null,
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
    const { user_id, album_title, artist, year, genre, cover_url, cover_score, final_score, final_rank, tracks } = req.body;
    if (!user_id || !album_title) return res.status(400).json({ error: 'Faltan datos' });
    const data = { user_id, album_title, artist, year, genre, cover_url, final_score, final_rank, tracks };
    if (cover_score !== undefined && cover_score !== '') data.cover_score = parseFloat(cover_score);
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
// Private rollout: Phase 1 data and UI are enabled only for the owner until
// the beta is explicitly opened. Backend enforcement prevents crafted clients.
const ACHIEVEMENT_BETA_USER = ADMIN_USER;
function isAchievementBetaUser(username) { return String(username || '').trim().toLowerCase() === ACHIEVEMENT_BETA_USER; }

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

// Rater access must observe session revocation immediately, so it deliberately skips
// the in-memory cache used by the shared Vault/Rater convenience endpoints.
async function verifyTokenFromStore(token) {
  if (!token) return null;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sessions?token=eq.${encodeURIComponent(token)}&limit=1`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  const data = await res.json();
  return data[0]?.username || null;
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

const sbHeaders = () => ({ 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` });
async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...options, headers: { ...sbHeaders(), ...(options.headers || {}) } });
  const text = await res.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!res.ok) throw new Error(typeof data === 'string' ? data : JSON.stringify(data));
  return data;
}
let achievementDefinitionsReady = false;
async function ensureAchievementDefinitions() {
  if (achievementDefinitionsReady) return;
  const rows = AchievementRules.DEFINITIONS.map(d => ({ key:d.key,title:d.title,category:d.category,rarity:d.rarity,max_level:d.maxLevel,rule_version:d.ruleVersion,enabled:true,client_metadata:{ badge:d.key, ...(d.metadata || {}) } }));
  await sb('vault_achievement_definitions?on_conflict=key', { method:'POST', headers:{ Prefer:'resolution=merge-duplicates,return=minimal' }, body:JSON.stringify(rows) });
  achievementDefinitionsReady = true;
}
async function saveCollectionWithAchievementEvents(username, collection, events) {
  const rows = await sb('rpc/achievement_save_collection_events', { method:'POST', body:JSON.stringify({ p_username:username, p_collection:collection || {}, p_events:events || [] }) });
  return rows || [];
}
async function getAchievementEvents(username, albumId = null) {
  let q = `vault_achievement_events?user_id=eq.${encodeURIComponent(username)}&select=event_id,occurred_at,type,payload,source,processed_at&order=occurred_at.asc`;
  const rows = await sb(q);
  return albumId ? rows.filter(e => String(e.payload?.album_id || '') === String(albumId)) : rows;
}
async function getAchievementState(username) {
  const rows = await sb(`vault_achievement_state?user_id=eq.${encodeURIComponent(username)}&select=user_id,achievement_tracking_started_at&limit=1`);
  return rows?.[0] || null;
}
async function ensureAchievementTracking(username) {
  const current = await getAchievementState(username); if (current?.achievement_tracking_started_at) return current;
  const startedAt = new Date().toISOString();
  // First activation is an irreversible cutoff.  Ignore a concurrent insert
  // instead of merging it: merging could move the cutoff forward and reject a
  // legitimate first event that was accepted by the other request.
  await sb('vault_achievement_state?on_conflict=user_id', { method:'POST', headers:{Prefer:'resolution=ignore-duplicates,return=minimal'}, body:JSON.stringify({user_id:username,achievement_tracking_started_at:startedAt,last_evaluated_at:startedAt}) });
  return (await getAchievementState(username)) || { user_id:username, achievement_tracking_started_at:startedAt };
}
async function writeProgress(username, progress) {
  const rows = (progress || []).filter(p=>!p.artistId).map(p => ({ user_id:username, achievement_key:p.key, current_level:p.currentLevel ?? 0, current_value:p.currentValue ?? null, target_value:p.targetValue ?? null, evaluated_at:new Date().toISOString() }));
  if (rows.length) await sb('vault_achievement_progress?on_conflict=user_id,achievement_key', { method:'POST', headers:{ Prefer:'resolution=merge-duplicates,return=minimal' }, body:JSON.stringify(rows) });
}
async function writeArtistAchievementProgress(username, progress) {
  const rows=(progress||[]).filter(p=>p.artistId).map(p=>({user_id:username,achievement_key:p.key,artist_id:p.artistId,current_level:p.currentLevel??0,current_value:p.currentValue??null,target_value:p.targetValue??null,evaluated_at:new Date().toISOString()}));
  if(rows.length) await sb('vault_artist_achievement_progress?on_conflict=user_id,achievement_key,artist_id',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(rows)});
}
async function refreshRatingRecords(username, eligibleEvents) {
  const records=[];
  for (const event of eligibleEvents || []) {
    if (event.type !== 'album_rescored') continue;
    const d=AchievementRules.score(event.payload?.delta), album=event.payload?.album;
    if(d>0) records.push({kind:'biggest_rating_comeback',delta:d,album});
    if(d<0) records.push({kind:'biggest_rating_drop',delta:Math.abs(d),album});
  }
  const rows=[];
  for (const kind of ['biggest_rating_comeback','biggest_rating_drop']) { const r=records.filter(x=>x.kind===kind).sort((a,b)=>b.delta-a.delta)[0]; if(r) rows.push({user_id:username,record_key:kind,value:{delta:r.delta,album:AchievementRules.brief(r.album)},observed_at:new Date().toISOString(),updated_at:new Date().toISOString()}); }
  if(rows.length) await sb('vault_personal_records?on_conflict=user_id,record_key',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(rows)});
}

// ── Phase 1.5 canonical musical identity ──────────────────────────────────
// MusicBrainz is consulted only by this server worker. The browser may retain a
// release MBID discovered during search, but it is merely evidence: the server
// validates it against MusicBrainz before writing any canonical link.
const MB_API_BASE = 'https://musicbrainz.org/ws/2';
const MB_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let mbNextRequestAt = 0, mbRequestChain = Promise.resolve();
const identityResolverRuns = new Set();
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
function safeMbId(value) { const id=String(value||'').trim(); return MB_UUID.test(id) ? id.toLowerCase() : null; }
function identityText(value) { return AchievementRules.normText(value).replace(/[^\p{L}\p{N}]+/gu,''); }
function albumReleaseMbid(album) { return safeMbId(album?.musicbrainzReleaseMbid || album?.releaseMbid || album?.mbid); }
async function mbJson(path) {
  const run = mbRequestChain.then(async () => {
    const wait=Math.max(0,mbNextRequestAt-Date.now()); if(wait) await sleep(wait);
    mbNextRequestAt=Date.now()+1100; // MusicBrainz public API: at most one request/sec.
    const url=`${MB_API_BASE}${path}${path.includes('?')?'&':'?'}fmt=json`;
    const response=await fetch(url,{headers:{Accept:'application/json','User-Agent':'AlbumVault/1.5 (identity resolver)'}});
    if(!response.ok) { const error=new Error(`MusicBrainz ${response.status}`); error.status=response.status; throw error; }
    return response.json();
  });
  mbRequestChain=run.catch(()=>{});
  return run;
}
function mbArtistCredit(entity) {
  const credits=(entity?.['artist-credit']||[]).map(c=>c?.artist).filter(Boolean);
  const ids=[...new Set(credits.map(a=>safeMbId(a.id)).filter(Boolean))];
  // Collaborations are intentionally unresolved in this minimal one-artist
  // model. Guessing a primary artist would make artist achievements unreliable.
  if(ids.length!==1) return null;
  const artist=credits.find(a=>safeMbId(a.id)===ids[0]);
  return artist ? {mbid:ids[0],name:artist.name||artist['sort-name']||''} : null;
}
function releaseGroupIsMainProject(group) {
  const primary=String(group?.['primary-type']||'');
  const secondary=(group?.['secondary-types']||[]).map(x=>String(x).toLowerCase());
  return (primary==='Album'||primary==='EP') && !secondary.some(x=>['compilation','live','remix','dj-mix','mixtape'].includes(x));
}
function mbDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value||'')) ? value : null; }
async function upsertCanonicalArtist(artist, source='musicbrainz') {
  const mbid=safeMbId(artist?.mbid||artist?.id); if(!mbid) throw new Error('MusicBrainz artist MBID missing');
  const name=String(artist?.name||artist?.['sort-name']||'').trim(); if(!name) throw new Error('MusicBrainz artist name missing');
  const rows=await sb('music_artists?on_conflict=musicbrainz_artist_mbid',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify({display_name:name,normalized_name:identityText(name),musicbrainz_artist_mbid:mbid,aliases:[],source,match_confidence:1,metadata:{musicbrainz:true},updated_at:new Date().toISOString()})});
  return rows?.[0];
}
async function upsertCanonicalReleaseGroup(group, artistRow, source, confidence) {
  const mbid=safeMbId(group?.id); if(!mbid) throw new Error('MusicBrainz release group MBID missing');
  const title=String(group?.title||'').trim(); if(!title) throw new Error('MusicBrainz release group title missing');
  const rows=await sb('music_release_groups?on_conflict=musicbrainz_release_group_mbid',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify({artist_id:artistRow.id,display_title:title,normalized_title:identityText(title),musicbrainz_release_group_mbid:mbid,primary_type:group?.['primary-type']||null,secondary_types:group?.['secondary-types']||[],first_release_date:mbDate(group?.['first-release-date']),is_main_project:releaseGroupIsMainProject(group),source,match_confidence:confidence,metadata:{musicbrainz:true},updated_at:new Date().toISOString()})});
  return rows?.[0];
}
async function fetchReleaseGroupFromRelease(releaseMbid) {
  const release=await mbJson(`/release/${releaseMbid}?inc=release-groups+artists`);
  const rgid=safeMbId(release?.['release-group']?.id); if(!rgid) return null;
  return mbJson(`/release-group/${rgid}?inc=artists`);
}
async function findStrictReleaseGroup(album) {
  const title=String(album?.title||'').trim(), artist=String(album?.artist||'').trim();
  if(!title||!artist) return {status:'unresolved',note:'missing_title_or_artist'};
  const query=`releasegroup:${JSON.stringify(title)} AND artist:${JSON.stringify(artist)}`;
  const result=await mbJson(`/release-group/?query=${encodeURIComponent(query)}&limit=10`);
  const exact=(result?.['release-groups']||[]).filter(group=>{
    const credit=mbArtistCredit(group);
    return identityText(group.title)===identityText(title) && credit && identityText(credit.name)===identityText(artist);
  });
  const ids=[...new Set(exact.map(group=>safeMbId(group.id)).filter(Boolean))];
  if(ids.length===1) return {status:'resolved',group:exact.find(group=>safeMbId(group.id)===ids[0]),source:'musicbrainz_strict_exact_metadata',confidence:.9};
  return ids.length>1 ? {status:'ambiguous',note:'multiple_exact_release_groups'} : {status:'unresolved',note:'no_unequivocal_musicbrainz_match'};
}
async function upsertVaultIdentity(username, album, patch) {
  const row={user_id:username,album_id:String(album.id),observed_title:String(album.title||''),observed_artist:String(album.artist||''),observed_year:String(album.year||''),updated_at:new Date().toISOString(),...patch};
  const rows=await sb('vault_album_identities?on_conflict=user_id,album_id',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify(row)});
  return rows?.[0];
}
async function ensureArtistDiscography(artistRow) {
  const existing=(await sb(`music_artist_discography_state?artist_id=eq.${artistRow.id}&limit=1`))?.[0];
  if(existing?.status==='complete') return existing;
  const artistMbid=safeMbId(artistRow.musicbrainz_artist_mbid); if(!artistMbid) throw new Error('canonical artist missing MBID');
  const all=[]; let offset=0,total=null,partial=false;
  // A bounded pagination cap protects a worker from unexpectedly huge artist
  // catalogs. A partial catalog is explicitly ineligible for Generational Run.
  for(let page=0;page<5;page++){
    const data=await mbJson(`/release-group/?artist=${artistMbid}&limit=100&offset=${offset}`);
    const groups=data?.['release-groups']||[]; total=Number(data?.['release-group-count']??groups.length); all.push(...groups); offset+=groups.length;
    if(offset>=total||groups.length<100) break;
    if(page===4) partial=true;
  }
  if(total!==null&&offset<total) partial=true;
  const indexed=[];
  for(const group of all){
    const credit=mbArtistCredit(group);
    if(!credit||credit.mbid!==artistMbid) continue;
    const row=await upsertCanonicalReleaseGroup(group,artistRow,'musicbrainz_discography',1);
    if(releaseGroupIsMainProject(group) && mbDate(group?.['first-release-date'])) indexed.push(row);
    else if(releaseGroupIsMainProject(group)) partial=true; // An undated comparable project makes adjacency unknowable.
  }
  indexed.sort((a,b)=>String(a.first_release_date).localeCompare(String(b.first_release_date))||String(a.id).localeCompare(String(b.id)));
  const state={artist_id:artistRow.id,status:partial?'partial':'complete',release_group_ids:indexed.map(x=>x.id),source:'musicbrainz_release_group_index',complete_at:partial?null:new Date().toISOString(),attempted_at:new Date().toISOString(),retry_after:partial?new Date(Date.now()+30*86400000).toISOString():null,metadata:{total_release_groups:total,indexed_main_projects:indexed.length},updated_at:new Date().toISOString()};
  const rows=await sb('music_artist_discography_state?on_conflict=artist_id',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify(state)});
  return rows?.[0];
}
async function emitIdentityResolved(username, album, identity) {
  const releaseGroupId=identity?.release_group_id; if(!releaseGroupId) return;
  const key=`identity_resolved:${album.id}:${releaseGroupId}`;
  const rows=await sb('vault_achievement_events?on_conflict=user_id,idempotency_key',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=representation'},body:JSON.stringify({user_id:username,occurred_at:new Date().toISOString(),type:'identity_resolved',payload_version:1,payload:{album_id:String(album.id),album:{id:String(album.id),title:album.title||'',artist:album.artist||'',year:album.year||'',score:album.score,status:album.status||'',coverUrl:album.coverUrl||''},release_group_id:releaseGroupId},source:'system_identity',idempotency_key:key})});
  if(rows?.[0]?.event_id) await processAchievementEvent(username,rows[0].event_id);
}
async function resolveVaultAlbumIdentity(username, album) {
  if(!album?.id) return {status:'unresolved'};
  const releaseMbid=albumReleaseMbid(album);
  try {
    let found;
    if(releaseMbid) {
      const group=await fetchReleaseGroupFromRelease(releaseMbid);
      found=group ? {status:'resolved',group,source:'musicbrainz_release_mbid',confidence:1} : {status:'unresolved',note:'release_without_release_group'};
    } else found=await findStrictReleaseGroup(album);
    if(found.status!=='resolved') {
      const retryDays=found.status==='ambiguous'?30:14;
      return upsertVaultIdentity(username,album,{status:found.status,source:'musicbrainz',match_confidence:null,release_mbid_evidence:releaseMbid,resolution_note:found.note||null,attempted_at:new Date().toISOString(),retry_after:new Date(Date.now()+retryDays*86400000).toISOString()});
    }
    const credit=mbArtistCredit(found.group);
    if(!credit) return upsertVaultIdentity(username,album,{status:'ambiguous',source:found.source,match_confidence:null,release_mbid_evidence:releaseMbid,resolution_note:'multi_artist_credit_requires_future_model',attempted_at:new Date().toISOString(),retry_after:new Date(Date.now()+30*86400000).toISOString()});
    const artist=await upsertCanonicalArtist({id:credit.mbid,name:credit.name},found.source);
    const group=await upsertCanonicalReleaseGroup(found.group,artist,found.source,found.confidence);
    await ensureArtistDiscography(artist).catch(error=>console.warn('[music identity discography]',error.message));
    const identity=await upsertVaultIdentity(username,album,{artist_id:artist.id,release_group_id:group.id,status:'resolved',source:found.source,match_confidence:found.confidence,release_mbid_evidence:releaseMbid,resolution_note:null,attempted_at:new Date().toISOString(),retry_after:null,metadata:{release_group_mbid:group.musicbrainz_release_group_mbid}});
    await emitIdentityResolved(username,album,identity);
    return identity;
  } catch(error) {
    const retryAfter=new Date(Date.now()+15*60*1000).toISOString();
    return upsertVaultIdentity(username,album,{status:'failed',source:'musicbrainz',match_confidence:null,release_mbid_evidence:releaseMbid,resolution_note:String(error.message||error).slice(0,300),attempted_at:new Date().toISOString(),retry_after:retryAfter});
  }
}
async function identityJobStats(username) {
  const rows=await sb(`vault_album_identities?user_id=eq.${encodeURIComponent(username)}&select=status,release_group_id`);
  const counts={resolved:0,unresolved:0,ambiguous:0,failed:0,pending:0};
  for(const row of rows||[]) counts[row.status]=(counts[row.status]||0)+1;
  const resolved=(rows||[]).filter(x=>x.status==='resolved'), duplicates=Math.max(0,resolved.length-new Set(resolved.map(x=>x.release_group_id)).size);
  return {...counts,editionDuplicates:duplicates,total:(rows||[]).length};
}
async function runIdentityResolutionBatch(username, limit=3) {
  const collection=await getVaultCollection(username), albums=(collection?.albums||[]).filter(a=>a?.id);
  const existing=await sb(`vault_album_identities?user_id=eq.${encodeURIComponent(username)}`);
  const byId=new Map((existing||[]).map(x=>[String(x.album_id),x])), now=Date.now();
  const work=albums.filter(album=>{ const row=byId.get(String(album.id)); return !row || (row.status!=='resolved' && (!row.retry_after || Date.parse(row.retry_after)<=now)); }).slice(0,Math.max(1,Math.min(5,Number(limit)||3)));
  await sb('vault_music_identity_jobs?on_conflict=user_id',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({user_id:username,status:work.length?'running':'complete',requested_at:new Date().toISOString(),started_at:new Date().toISOString(),updated_at:new Date().toISOString()})});
  for(const album of work) await resolveVaultAlbumIdentity(username,album);
  const stats=await identityJobStats(username);
  const latest=await sb(`vault_album_identities?user_id=eq.${encodeURIComponent(username)}&select=album_id,status,retry_after`);
  const latestById=new Map((latest||[]).map(x=>[String(x.album_id),x]));
  const hasReady=albums.some(album=>{ const row=latestById.get(String(album.id)); return !row || (row.status!=='resolved'&&(!row.retry_after||Date.parse(row.retry_after)<=Date.now())); });
  await sb(`vault_music_identity_jobs?user_id=eq.${encodeURIComponent(username)}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({status:hasReady?'queued':'complete',completed_at:hasReady?null:new Date().toISOString(),resolved_count:stats.resolved,unresolved_count:stats.unresolved,ambiguous_count:stats.ambiguous,edition_duplicates_count:stats.editionDuplicates,metadata:{total_albums:albums.length,links:stats.total},updated_at:new Date().toISOString()})});
  return {hasReady,stats,processed:work.length};
}
function scheduleIdentityResolution(username) {
  if(identityResolverRuns.has(username)) return;
  identityResolverRuns.add(username);
  const tick=async()=>{ try { const result=await runIdentityResolutionBatch(username,3); if(result.hasReady) return setTimeout(tick,1400); } catch(error) { console.error('[music identity job]',error.message); } finally { /* a scheduled continuation keeps the lock */ } identityResolverRuns.delete(username); };
  setTimeout(tick,80);
}
async function schedulePrivateIdentityBackfill() {
  // Keep the beta owner case-safe: the existing app identity is not normalized
  // in the users table, while the beta check intentionally is.
  const rows=await sb('users?username=ilike.kyujin&select=username&limit=1');
  if(rows?.[0]?.username) scheduleIdentityResolution(rows[0].username);
}
async function getCanonicalAchievementContext(username, eligibleEvents) {
  const albumIds=new Set((eligibleEvents||[]).map(e=>String(e?.payload?.album_id||AchievementRules.albumId(e?.payload?.album))).filter(Boolean));
  if(!albumIds.size) return {canonicalIdentityByAlbumId:{},releaseGroupsById:{},artistDiscographies:{}};
  const identities=await sb(`vault_album_identities?user_id=eq.${encodeURIComponent(username)}&select=album_id,status,artist_id,release_group_id`);
  const selected=(identities||[]).filter(x=>albumIds.has(String(x.album_id))), map=Object.fromEntries(selected.map(x=>[String(x.album_id),x]));
  const groupIds=[...new Set(selected.map(x=>x.release_group_id).filter(Boolean))]; if(!groupIds.length) return {canonicalIdentityByAlbumId:map,releaseGroupsById:{},artistDiscographies:{}};
  const groups=await sb(`music_release_groups?id=in.(${groupIds.join(',')})&select=id,artist_id,display_title,musicbrainz_release_group_mbid,primary_type,first_release_date`);
  const artistIds=[...new Set((groups||[]).map(x=>x.artist_id).filter(Boolean))];
  const artists=artistIds.length?await sb(`music_artists?id=in.(${artistIds.join(',')})&select=id,display_name,musicbrainz_artist_mbid`):[];
  const artistById=Object.fromEntries((artists||[]).map(x=>[x.id,x]));
  const states=artistIds.length?await sb(`music_artist_discography_state?artist_id=in.(${artistIds.join(',')})&select=artist_id,status,release_group_ids,source,complete_at`):[];
  const releaseGroupsById={}; for(const group of groups||[]) releaseGroupsById[group.id]={...group,artist:artistById[group.artist_id]||null};
  const artistDiscographies={}; for(const state of states||[]) artistDiscographies[state.artist_id]={complete:state.status==='complete',release_group_ids:Array.isArray(state.release_group_ids)?state.release_group_ids:[],source:state.source,complete_at:state.complete_at};
  return {canonicalIdentityByAlbumId:map,releaseGroupsById,artistDiscographies};
}
async function processAchievementEvent(username, eventId) {
  const state = await ensureAchievementTracking(username);
  const events = await getAchievementEvents(username);
  const event = events.find(e=>e.event_id===eventId); if (!event || event.processed_at) return [];
  const eligibleEvents = AchievementRules.eligibleAfter(events, state.achievement_tracking_started_at);
  if (!eligibleEvents.some(e=>e.event_id===eventId)) {
    await sb(`vault_achievement_events?event_id=eq.${eventId}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({processed_at:new Date().toISOString(),processing_error:'before_tracking_started'})});
    return [];
  }
  const identityContext = await getCanonicalAchievementContext(username, eligibleEvents);
  const evaluation = AchievementRules.evaluate({ event, eligibleEvents, ...identityContext });
  await writeProgress(username, evaluation.progress);
  await writeArtistAchievementProgress(username, evaluation.artistProgress);
  const unlocks=[];
  for (const c of evaluation.candidates) {
    const definition=AchievementRules.DEFINITIONS.find(d=>d.key===c.key); if(!definition) continue;
    const levelRarity=definition.metadata?.levelRarities?.[c.level-1] || definition.rarity;
    const snapshot={ ...c.snapshot, level_rarity:levelRarity, source:event.source, occurred_at:event.occurred_at, rule_version:definition.ruleVersion };
    const inserted=await sb('vault_achievement_unlocks?on_conflict=user_id,achievement_key,level',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=representation'},body:JSON.stringify({user_id:username,achievement_key:c.key,level:c.level,unlocked_at:new Date().toISOString(),source:event.source,rule_version:definition.ruleVersion,snapshot})});
    if(Array.isArray(inserted)&&inserted[0]) { unlocks.push(inserted[0]); await sb('vault_achievement_inbox',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify({user_id:username,unlock_id:inserted[0].id,source:event.source})}); }
  }
  await refreshRatingRecords(username, eligibleEvents);
  await sb(`vault_achievement_events?event_id=eq.${eventId}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({processed_at:new Date().toISOString(),unlock_ids:unlocks.map(u=>u.id)})});
  return unlocks;
}
async function processAchievementEvents(username, eventIds) {
  const all=[]; for (const id of eventIds || []) all.push(...await processAchievementEvent(username,id)); return all;
}
async function achievementReadModel(username) {
  await ensureAchievementDefinitions();
  const [defs,progress,artistProgress,unlocks,showcase,records,inbox,state] = await Promise.all([
    sb('vault_achievement_definitions?enabled=eq.true&order=key.asc'), sb(`vault_achievement_progress?user_id=eq.${encodeURIComponent(username)}`),
    sb(`vault_artist_achievement_progress?user_id=eq.${encodeURIComponent(username)}&order=current_value.desc`),
    sb(`vault_achievement_unlocks?user_id=eq.${encodeURIComponent(username)}&select=id,achievement_key,level,unlocked_at,source,public_visible,snapshot&order=unlocked_at.desc`),
    sb(`vault_achievement_showcase?user_id=eq.${encodeURIComponent(username)}&order=position.asc`), sb(`vault_personal_records?user_id=eq.${encodeURIComponent(username)}`),
    sb(`vault_achievement_inbox?user_id=eq.${encodeURIComponent(username)}&delivered_at=is.null&order=created_at.asc`), sb(`vault_achievement_state?user_id=eq.${encodeURIComponent(username)}&select=achievement_tracking_started_at&limit=1`)
  ]);
  return { definitions:defs, progress, artistProgress, unlocks, showcase, records, inbox, trackingStartedAt:state?.[0]?.achievement_tracking_started_at || null, availableCount:defs.length, unlockedFamilies:new Set(unlocks.map(u=>u.achievement_key)).size };
}

// ── Migración única de portadas de Vault ──
// Corre en el servidor, no expone ninguna ruta pública ni modifica álbumes si
// iTunes no devuelve exactamente el mismo título y artista.
const COVER_QUALITY_MIGRATION_VERSION = 'v1';

function normalizeCoverMatch(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function toHighResItunesArtwork(url) {
  return typeof url === 'string'
    ? url.replace(/\d+x\d+bb/i, '1200x1200bb')
    : '';
}

async function findExactHighResItunesCover(title, artist) {
  if (!title || !artist) return null;
  try {
    const query = encodeURIComponent(`${artist} ${title}`.trim());
    const response = await fetch(`https://itunes.apple.com/search?term=${query}&media=music&entity=album&limit=8`);
    if (!response.ok) return null;
    const { results = [] } = await response.json();
    const targetTitle = normalizeCoverMatch(title);
    const targetArtist = normalizeCoverMatch(artist);
    const match = results.find(item =>
      normalizeCoverMatch(item.collectionName) === targetTitle &&
      normalizeCoverMatch(item.artistName) === targetArtist
    );
    return match?.artworkUrl100 ? toHighResItunesArtwork(match.artworkUrl100) : null;
  } catch {
    return null;
  }
}

async function getPendingVaultCoverMigrations() {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/users?cover_quality_migrated_at=is.null&vault_collection=not.is.null&select=id,vault_collection`,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
  );
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function completeVaultCoverMigration(userId, collection) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({
      vault_collection: collection,
      cover_quality_migrated_at: new Date().toISOString()
    })
  });
  if (!response.ok) throw new Error(await response.text());
}

async function runVaultCoverQualityMigration() {
  try {
    const users = await getPendingVaultCoverMigrations();
    let migratedUsers = 0;
    let upgradedCovers = 0;

    for (const user of users) {
      const collection = user.vault_collection;
      const albums = Array.isArray(collection?.albums) ? collection.albums : [];
      let changed = false;

      for (const album of albums) {
        if (!album?.coverUrl || !album?.title || !album?.artist) continue;

        // Una URL de Apple ya es válida: se normaliza a 1200 px sin otra consulta.
        if (/mzstatic\.com/i.test(album.coverUrl)) {
          const highRes = toHighResItunesArtwork(album.coverUrl);
          if (highRes && highRes !== album.coverUrl) {
            album.coverUrl = highRes;
            changed = true;
            upgradedCovers++;
          }
          continue;
        }

        const highRes = await findExactHighResItunesCover(album.title, album.artist);
        if (highRes && highRes !== album.coverUrl) {
          album.coverUrl = highRes;
          changed = true;
          upgradedCovers++;
        }

        // No se hacen ráfagas contra iTunes aunque haya más perfiles en el futuro.
        await new Promise(resolve => setTimeout(resolve, 160));
      }

      await completeVaultCoverMigration(user.id, collection);
      migratedUsers++;
    }

    if (migratedUsers) {
      console.log(`[vault-cover-quality ${COVER_QUALITY_MIGRATION_VERSION}] perfiles: ${migratedUsers}, portadas mejoradas: ${upgradedCovers}`);
    }
  } catch (error) {
    console.error('[vault-cover-quality] migración pendiente; se reintentará en el próximo inicio:', error.message);
  }
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

// El Rater sigue requiriendo una sesión válida, pero está disponible para todos los usuarios.
app.post('/rater-access', express.json(), async (req, res) => {
  try {
    const { token } = req.body;
    const username = await verifyTokenFromStore(token);
    if (!username) return res.status(401).json({ error: 'Sesión inválida o expirada' });
    res.json({ ok: true, username });
  } catch (err) {
    console.error('[rater-access]', err.message);
    res.status(500).json({ error: 'No se pudo verificar el acceso al Rater' });
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
// Una colección grande (cientos de álbumes con tracks/reseñas) supera con
// facilidad el límite por defecto de Express (100 KB). El límite sigue siendo
// acotado para no permitir cuerpos arbitrarios en memoria.
app.post('/vault-collection', express.json({ limit: '2mb' }), async (req, res) => {
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

// Phase 1 achievement events share the collection write through an RPC transaction.
// The client may request a fact to be evaluated, but the server derives every unlock.
app.post('/vault-collection/events', express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const { token, collection, events } = req.body;
    const username = await verifyToken(token);
    if (!username) return res.status(401).json({ error: 'Sesión inválida o expirada' });
    if (!isAchievementBetaUser(username)) { await saveVaultCollection(username, collection ?? null); return res.json({ ok:true, beta:false }); }
    if (!Array.isArray(events) || !events.length || events.length > 30) return res.status(400).json({ error: 'Eventos inválidos' });
    await ensureAchievementDefinitions();
    await ensureAchievementTracking(username);
    const permitted = new Set(['album_rated','album_added','review_written','review_updated','album_rescored','track_scores_saved']);
    for (const event of events) {
      if (!permitted.has(event?.type) || !event?.idempotency_key || !event?.payload || String(event.idempotency_key).length > 240) return res.status(400).json({ error:'Evento incompleto' });
      event.payload_version = 1; event.source = ['rater','vault'].includes(event.source) ? event.source : 'vault';
      if (event.type === 'review_written' || event.type === 'review_updated') {
        const album = event.payload.album || {};
        const review = String(event.payload.review_text || '').slice(0, 12000);
        event.payload.substantial = AchievementRules.substantialReview(review, album);
        event.payload.excerpt = event.payload.substantial ? review.replace(/\s+/g,' ').trim().slice(0, 180) : null;
        delete event.payload.review_text;
      }
    }
    const saved = await saveCollectionWithAchievementEvents(username, collection ?? {}, events);
    const unlocks = await processAchievementEvents(username, saved.map(x=>x.event_id));
    // Never hold the rating request open on MusicBrainz. The durable resolver
    // picks it up after the collection/event transaction has completed.
    scheduleIdentityResolution(username);
    res.json({ ok:true, eventIds:saved.map(x=>x.event_id), unlocks:unlocks.map(x=>x.id) });
  } catch (err) { console.error('[achievement events]',err.message); res.status(500).json({ error:'No se pudieron guardar los eventos del Vault' }); }
});

app.post('/achievements/activate', express.json(), async (req,res) => {
  try {
    const username=await verifyToken(req.body?.token); if(!username) return res.status(401).json({error:'Sesión inválida o expirada'});
    if (!isAchievementBetaUser(username)) return res.json({ok:true,beta:false});
    await ensureAchievementDefinitions();
    // Activation is intentionally empty: historical Vault data is not a baseline.
    await ensureAchievementTracking(username);
    scheduleIdentityResolution(username);
    res.json({ok:true, ...(await achievementReadModel(username))});
  } catch(err) { console.error('[achievement baseline]',err.message); res.status(500).json({error:'No se pudo activar Achievement Vault'}); }
});
app.post('/achievements/me', express.json(), async (req,res) => {
  try { const username=await verifyToken(req.body?.token); if(!username) return res.status(401).json({error:'Sesión inválida o expirada'}); if(!isAchievementBetaUser(username)) return res.json({ok:true,beta:false}); scheduleIdentityResolution(username); res.json({ok:true,...(await achievementReadModel(username))}); }
  catch(err) { console.error('[achievement read]',err.message); res.status(500).json({error:'No se pudieron leer los achievements'}); }
});

// Private beta diagnostics: no raw MBID is accepted from the client and this
// endpoint only starts/resumes the bounded server resolver for the signed-in
// owner. It is intentionally not a public MusicBrainz proxy.
app.post('/music-identity/status', express.json(), async (req,res) => {
  try {
    const username=await verifyToken(req.body?.token); if(!username) return res.status(401).json({error:'Sesión inválida o expirada'});
    if(!isAchievementBetaUser(username)) return res.status(403).json({error:'Music identity está en beta privada'});
    const [job,stats]=await Promise.all([sb(`vault_music_identity_jobs?user_id=eq.${encodeURIComponent(username)}&limit=1`),identityJobStats(username)]);
    res.json({ok:true,job:job?.[0]||null,stats});
  } catch(error) { console.error('[music identity status]',error.message); res.status(500).json({error:'No se pudo leer el estado de identidad'}); }
});
app.post('/music-identity/resolve', express.json(), async (req,res) => {
  try {
    const username=await verifyToken(req.body?.token); if(!username) return res.status(401).json({error:'Sesión inválida o expirada'});
    if(!isAchievementBetaUser(username)) return res.status(403).json({error:'Music identity está en beta privada'});
    scheduleIdentityResolution(username);
    res.status(202).json({ok:true,queued:true});
  } catch(error) { console.error('[music identity resolve]',error.message); res.status(500).json({error:'No se pudo iniciar la resolución'}); }
});
app.post('/achievements/inbox/consume', express.json(), async (req,res) => {
  try { const username=await verifyToken(req.body?.token); if(!username) return res.status(401).json({error:'Sesión inválida o expirada'}); if(!isAchievementBetaUser(username)) return res.json({ok:true,beta:false}); const ids=(req.body?.ids||[]).filter(x=>typeof x==='string').slice(0,20); if(ids.length) await sb(`vault_achievement_inbox?user_id=eq.${encodeURIComponent(username)}&id=in.(${ids.map(encodeURIComponent).join(',')})`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({delivered_at:new Date().toISOString()})}); res.json({ok:true}); }
  catch(err) { console.error('[achievement inbox]',err.message); res.status(500).json({error:'No se pudo actualizar la bandeja'}); }
});
app.post('/achievements/showcase', express.json(), async (req,res) => {
  try {
    const username=await verifyToken(req.body?.token); if(!username) return res.status(401).json({error:'Sesión inválida o expirada'});
    if (!isAchievementBetaUser(username)) return res.status(403).json({error:'Achievement Vault está en beta privada'});
    const keys=[...new Set((req.body?.keys||[]).filter(x=>typeof x==='string'))].slice(0,6);
    const unlocked=await sb(`vault_achievement_unlocks?user_id=eq.${encodeURIComponent(username)}&select=achievement_key`); const allowed=new Set(unlocked.map(x=>x.achievement_key));
    if(keys.some(k=>!allowed.has(k))) return res.status(400).json({error:'Solo podés exhibir achievements desbloqueados'});
    await sb(`vault_achievement_showcase?user_id=eq.${encodeURIComponent(username)}`,{method:'DELETE',headers:{Prefer:'return=minimal'}});
    if(keys.length) await sb('vault_achievement_showcase',{method:'POST',headers:{Prefer:'return=minimal'},body:JSON.stringify(keys.map((achievement_key,i)=>({user_id:username,achievement_key,position:i+1})))});
    res.json({ok:true,keys});
  } catch(err) { console.error('[achievement showcase]',err.message); res.status(500).json({error:'No se pudo guardar el showcase'}); }
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
    const url = `${SUPABASE_URL}/rest/v1/users?or=(discord_username.ilike.${encodeURIComponent(pattern)},username.ilike.${encodeURIComponent(pattern)})&select=username,discord_username,discord_avatar&limit=12`;
    const sbRes = await fetch(url, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const rows = await sbRes.json();
    if (!sbRes.ok || !Array.isArray(rows)) {
      return res.status(500).json({ error: 'No se pudieron buscar usuarios' });
    }

    const seen = new Set();
    const users = rows
      .filter(row => row.discord_username || row.username)
      .filter(row => {
        const key = (row.discord_username || row.username).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 8)
      .map(row => ({
        discord_username: row.discord_username || row.username,
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
    const profilePattern = discordUsername.replace(/[*,()]/g, '');
    const url = `${SUPABASE_URL}/rest/v1/users?or=(discord_username.ilike.${encodeURIComponent(profilePattern)},username.ilike.${encodeURIComponent(profilePattern)})&select=username,discord_username,discord_avatar,vault_profile,vault_collection`;
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
      discord_username: profileUser.discord_username || profileUser.username,
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

// Respuesta compacta y observable para cuerpos demasiado grandes. Sin este
// manejador Express imprimía el stack completo repetidamente y el cliente no
// recibía una causa útil para detener el intento.
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large' || err?.code === 'LIMIT_FILE_SIZE') {
    const size = req.headers['content-length'] || 'desconocido';
    console.warn(`[payload-too-large] ${req.method} ${req.path} content-length=${size}`);
    return res.status(413).json({ error: 'Payload demasiado grande para esta operación.' });
  }
  next(err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  // Corre después de que Render marque el proceso como disponible.
  setTimeout(() => { runVaultCoverQualityMigration(); }, 3000);
  // Phase 1.5 backfill is bounded, persisted and restartable. It resolves
  // identity only; historical Vault facts remain ineligible for achievements.
  setTimeout(() => { schedulePrivateIdentityBackfill().catch(error => console.error('[music identity startup]',error.message)); }, 10000);
});

      
