const express   = require('express');
const multer    = require('multer');
const fetch     = require('node-fetch');
const FormData  = require('form-data');
const sharp     = require('sharp');
const puppeteer = require('puppeteer');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const AchievementRules = require('./achievement-rules');
const ListeningRules = require('./listening-rules');
const TemporalListeningRules = require('./temporal-listening-rules');
const EmblemRules = require('./emblem-rules');
const ListeningIntelligence = require('./listening-intelligence');
const HybridRules = require('./hybrid-rules');
const DiscoveryRules = require('./discovery-rules');
const PeriodIntelligence = require('./period-intelligence');
const { achievementTrustBoundary } = require('./secret-visibility');
const { normalizeIanaTimezone, localListeningParts } = require('./timezone-utils');
const { classifyEnrichmentError, parseRetryAfter, retryDelayMs } = require('./enrichment-reliability');
const { createSchedulerPipelines } = require('./scheduler-pipelines');
const { normalizeDiscordThreadId, discordPostFailure } = require('./discord-posting');

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
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const LASTFM_API_KEY = process.env.LASTFM_API_KEY;
const LASTFM_API_BASE = 'https://ws.audioscrobbler.com/2.0/';
const LASTFM_OVERLAP_MS = 10 * 60 * 1000;
const LASTFM_MAX_PAGES_PER_SYNC = 5;
const LASTFM_PAGE_SIZE = 200;

// ── Discord OAuth (login web, distinto del bot de gateway) ──
// CLIENT_ID se reutiliza (es la misma app de Discord que ya tenés).
const CLIENT_ID = process.env.CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET; // Nuevo: sacalo de Discord Developer Portal → OAuth2
const DISCORD_REDIRECT_URI  = process.env.DISCORD_REDIRECT_URI;  // Nuevo: ej. https://album-rater-bot.onrender.com/auth/discord/callback
                                                                   // Debe estar registrada tal cual en Discord Developer Portal → OAuth2 → Redirects
// El Rater está temporalmente reservado para la cuenta propietaria. Vault sigue usando el login compartido sin esta restricción.
const oauthStates = {}; // state (random) -> { returnTo, expires }  — anti-CSRF + para saber a qué página volver (Rater o Vault)
const pendingDiscordProfiles = {}; // pendingToken -> { discordId, discordUsername, discordAvatar, expires } — cuenta de Discord sin match automático, esperando que el usuario confirme si tiene cuenta vieja

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
  // Los comandos se registran explícitamente con `npm run register:discord-commands`.
  // Reescribirlos en cada reinicio del web service genera llamadas innecesarias a Discord.
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
const MUSIC_IDENTITY_REVISION = 'phase15-musicbrainz-release-groups.6';
const LISTENING_LEDGER_REVISION = 'phase2-lastfm-ledger.1';
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
      listening_ledger_revision: LISTENING_LEDGER_REVISION,
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

async function getRaterDiscordThreadId(username) {
  const rows = await sb(`rater_discord_settings?user_id=eq.${encodeURIComponent(username)}&select=thread_id&limit=1`);
  return normalizeDiscordThreadId(rows?.[0]?.thread_id);
}

async function saveRaterDiscordThreadId(username, threadId) {
  const normalized = normalizeDiscordThreadId(threadId);
  if (!normalized) throw new Error('Thread ID inválido');
  await sb('rater_discord_settings?on_conflict=user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ user_id: username, thread_id: normalized, updated_at: new Date().toISOString() })
  });
  return normalized;
}

app.post('/post', upload.single('file'), async (req, res) => {
  try {
    const { title, artist, cover_url, cover_score, tracks, final_score, final_rank, notes, auth_token } = req.body || {};
    const username = await verifyTokenFromStore(auth_token);
    if (!username) return res.status(401).json({ error: 'Sesión inválida o expirada' });
    if (!req.file)  return res.status(400).json({ error: 'No image provided' });
    if (!title)     return res.status(400).json({ error: 'No title provided' });
    const thread_id = await getRaterDiscordThreadId(username);
    if (!thread_id) return res.status(409).json({ error: 'Configurá y guardá tu Thread ID de Discord antes de enviar.' });

    const form = new FormData();
    form.append('payload_json', JSON.stringify({ attachments: [{ id: '0', filename: 'rating.png' }] }), { contentType: 'application/json' });
    form.append('files[0]', req.file.buffer, { filename: 'rating.png', contentType: 'image/png' });

    const discordRes = await fetch(`https://discord.com/api/v10/channels/${thread_id}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bot ${BOT_TOKEN}`, ...form.getHeaders() },
      body: form
    });
    let discordData = {};
    try { discordData = await discordRes.json(); } catch (_) {}
    if (!discordRes.ok) {
      const failure = discordPostFailure(discordRes, discordData);
      console.warn('[discord-post]', JSON.stringify({
        event: 'discord_post_failed',
        user: username,
        discord_status: discordRes.status,
        code: failure.code,
        retry_after_seconds: failure.retry_after_seconds,
        scope: failure.scope,
        global: failure.global,
        bucket: failure.bucket
      }));
      if (failure.retry_after_seconds !== null && failure.retry_after_seconds !== undefined) {
        res.set('Retry-After', String(failure.retry_after_seconds));
      }
      return res.status(failure.status).json(failure);
    }

    try {
      const cleanTitle = req.body.album_title || title;
      await saveRating({
        user_id: username,
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

    if (cover_url) changeBotPfp(cover_url).catch(console.error);

    res.json({ ok: true, message: discordData.id });
  } catch(err) {
    console.error('[discord-post]', err.message);
    res.status(500).json({ error: 'No se pudo completar el envío a Discord.' });
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
const ALL_ACHIEVEMENT_DEFINITIONS = [...AchievementRules.DEFINITIONS,...DiscoveryRules.DEFINITIONS];
async function ensureAchievementDefinitions() {
  if (achievementDefinitionsReady) return;
  const rows = ALL_ACHIEVEMENT_DEFINITIONS.map(d => ({ key:d.key,title:d.title,category:d.category,rarity:d.rarity,max_level:d.maxLevel,rule_version:d.ruleVersion,enabled:d.enabled!==false,is_secret:Boolean(d.metadata?.secret),is_discovery:Boolean(d.metadata?.discovery),emblem_eligible:d.metadata?.emblemEligible!==false,client_metadata:{ badge:d.key, ...(d.metadata || {}) } }));
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
async function persistAchievementCandidates(username, candidates, source, occurredAt) {
  await ensureAchievementDefinitions();
  const unlocks=[];
  for (const c of candidates || []) {
    const definition=ALL_ACHIEVEMENT_DEFINITIONS.find(d=>d.key===c.key && d.enabled!==false); if(!definition) continue;
    const levelRarity=definition.metadata?.levelRarities?.[c.level-1] || definition.rarity;
    // This object is the immutable Memory Card. Later profile, cover, rating or
    // canonical-metadata edits never patch an existing unlock snapshot.
    const snapshot={ ...c.snapshot, level_rarity:levelRarity, source, occurred_at:occurredAt, rule_version:definition.ruleVersion };
    const inserted=await sb('rpc/achievement_unlock_with_inbox',{method:'POST',body:JSON.stringify({p_user_id:username,p_achievement_key:c.key,p_level:c.level,p_source:source,p_rule_version:definition.ruleVersion,p_snapshot:snapshot,p_unlocked_at:new Date().toISOString()})});
    if(Array.isArray(inserted)&&inserted[0]) {
      unlocks.push(inserted[0]);
    }
  }
  return unlocks;
}
const COSMETIC_REWARDS=[
  {key:'certified',title:'Certified',achievementKey:'certified_favorite',minimumLevel:1},
  {key:'the_archivist',title:'The Archivist',achievementKey:'archivist',minimumLevel:5},
  {key:'questionable_taste',title:'Questionable Taste',achievementKey:'love_foolish',minimumLevel:1},
  {key:'still_listening',title:'Still Listening',achievementKey:'love_foolish',minimumLevel:2},
  {key:'no_skips_allowed',title:'No Skips Allowed',achievementKey:'perfect_world',minimumLevel:1}
];
async function syncCosmeticEntitlements(username,unlocks=null) {
  const rows=unlocks||await sb(`vault_achievement_unlocks?user_id=eq.${encodeURIComponent(username)}&select=id,achievement_key,level,unlocked_at`), grants=[];
  for(const reward of COSMETIC_REWARDS){const source=rows.filter(row=>row.achievement_key===reward.achievementKey&&Number(row.level)>=reward.minimumLevel).sort((a,b)=>Number(a.level)-Number(b.level))[0];if(source)grants.push({user_id:username,cosmetic_key:reward.key,source_achievement_key:reward.achievementKey,source_unlock_id:source.id,granted_at:source.unlocked_at,metadata:{title:reward.title,minimum_level:reward.minimumLevel}});}
  if(grants.length)await sb('vault_cosmetic_entitlements?on_conflict=user_id,cosmetic_key',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=minimal'},body:JSON.stringify(grants)});
}
async function emblemEvaluationInput(username) {
  const [definitions,unlocks,state,events]=await Promise.all([
    sb('vault_achievement_definitions?enabled=eq.true&select=key,category,rarity,enabled,is_secret,is_discovery,emblem_eligible,client_metadata'),
    sb(`vault_achievement_unlocks?user_id=eq.${encodeURIComponent(username)}&select=id,achievement_key,level,snapshot`),getAchievementState(username),getAchievementEvents(username)
  ]);
  const eligible=state?.achievement_tracking_started_at?AchievementRules.eligibleAfter(events,state.achievement_tracking_started_at):[];
  const ratedAlbumIds=eligible.filter(event=>event.type==='album_rated'&&event.payload?.album?.status==='listened').map(eventAlbumId).filter(Boolean);
  return {definitions,unlocks,ratedAlbumIds};
}
async function refreshEmblemState(username) {
  const evaluation=EmblemRules.evaluate(await emblemEvaluationInput(username));
  const upgrades=await sb(`vault_emblem_upgrades?user_id=eq.${encodeURIComponent(username)}&select=tier_level,tier_key,evidence,eligible_at,acknowledged_at&order=tier_level.asc`),currentLevel=Math.max(0,...(upgrades||[]).map(row=>Number(row.tier_level)));
  const next=EmblemRules.TIERS.find(tier=>tier.level===currentLevel+1),pending=next&&evaluation.qualified.some(tier=>tier.level===next.level)?next:null,now=new Date().toISOString();
  const pendingSnapshot=pending?{tier:{id:pending.id,level:pending.level,title:pending.title},metrics:evaluation.metrics,evidence_version:1,rule_version:1,eligible_at:now}:null;
  await sb('vault_emblem_state?on_conflict=user_id',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({user_id:username,current_level:currentLevel,pending_level:pending?.level||null,pending_snapshot:pendingSnapshot,progress:{metrics:evaluation.metrics,highest_qualified:evaluation.highestQualified?.level||0},evaluated_at:now,updated_at:now})});
  return {currentLevel,pending:pendingSnapshot,progress:{metrics:evaluation.metrics,highestQualified:evaluation.highestQualified?.level||0},upgrades:upgrades||[],tiers:EmblemRules.TIERS.map(({id,level,title,requirements})=>({id,level,title,requirements}))};
}
async function acknowledgePendingEmblem(username) {
  const state=(await sb(`vault_emblem_state?user_id=eq.${encodeURIComponent(username)}&select=current_level,pending_level,pending_snapshot&limit=1`))?.[0];
  if(!state?.pending_level||Number(state.pending_level)!==Number(state.current_level)+1)return refreshEmblemState(username);
  const snapshot=state.pending_snapshot,tier=EmblemRules.TIERS.find(row=>row.level===Number(state.pending_level)); if(!tier)return refreshEmblemState(username);
  await sb('vault_emblem_upgrades?on_conflict=user_id,tier_level',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=minimal'},body:JSON.stringify({user_id:username,tier_level:tier.level,tier_key:tier.id,evidence:snapshot,eligible_at:snapshot?.eligible_at||new Date().toISOString(),rule_version:1})});
  return refreshEmblemState(username);
}
async function refreshAchievementPrevalence(username) {
  // The current rollout has one eligible beta account. Cache the real cohort,
  // but never display percentages until the approved k=30 privacy threshold.
  const [definitions,unlocks,state]=await Promise.all([
    sb('vault_achievement_definitions?enabled=eq.true&is_discovery=eq.false&select=key'),
    sb(`vault_achievement_unlocks?user_id=eq.${encodeURIComponent(username)}&select=achievement_key`),
    sb(`vault_achievement_state?user_id=eq.${encodeURIComponent(username)}&select=user_id&limit=1`)
  ]);
  const unlocked=new Set((unlocks||[]).map(row=>row.achievement_key)),population=state?.length?1:0,now=new Date().toISOString();
  const rows=(definitions||[]).map(row=>({achievement_key:row.key,eligible_population:population,unlocked_population:unlocked.has(row.key)?1:0,percentage:population?(unlocked.has(row.key)?100:0):null,display_enabled:false,calculated_at:now}));
  if(rows.length)await sb('vault_achievement_prevalence?on_conflict=achievement_key',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(rows)});
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
    if(!response.ok) {
      const error=new Error(`MusicBrainz ${response.status}`);
      error.status=response.status;
      error.retryAfterMs=parseRetryAfter(response.headers.get('retry-after'));
      throw error;
    }
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
    if(error?.status===404) {
      return upsertVaultIdentity(username,album,{status:'unresolved',source:'musicbrainz',match_confidence:null,release_mbid_evidence:releaseMbid,resolution_note:'musicbrainz_not_found',attempted_at:new Date().toISOString(),retry_after:new Date(Date.now()+14*86400000).toISOString()});
    }
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
  const jobStatus=hasReady?'queued':(stats.failed?'partial':'complete');
  await sb(`vault_music_identity_jobs?user_id=eq.${encodeURIComponent(username)}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({status:jobStatus,completed_at:hasReady?null:new Date().toISOString(),resolved_count:stats.resolved,unresolved_count:stats.unresolved,ambiguous_count:stats.ambiguous,edition_duplicates_count:stats.editionDuplicates,metadata:{total_albums:albums.length,links:stats.total},updated_at:new Date().toISOString()})});
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

// ── Phase 2: Last.fm persistent listening ledger ──────────────────────────
// Existing browser polling remains only a visual "Now Listening" feature.  The
// following worker is the sole writer of tracked scrobbles and achievements.
function normalizedLastfmUsername(value) { return String(value||'').trim().toLowerCase(); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function lastfmTrackText(track, field) { const value=track?.[field]; return String(value?.['#text'] || value?.name || value || '').trim(); }
function confirmedLastfmTrack(track) { return Boolean(track?.date?.uts) && !track?.['@attr']?.nowplaying; }
function lastfmFingerprint(epochId, track) {
  const uts=String(track?.date?.uts||'');
  return sha256([epochId,uts,AchievementRules.normText(lastfmTrackText(track,'artist')),AchievementRules.normText(lastfmTrackText(track,'name')),AchievementRules.normText(lastfmTrackText(track,'album')),safeMbId(track?.artist?.mbid)||'',safeMbId(track?.album?.mbid)||'',safeMbId(track?.mbid)||''].join('|'));
}
async function lastfmApi(params) {
  if(!LASTFM_API_KEY) { const error=new Error('Last.fm is not configured'); error.code='lastfm_not_configured'; throw error; }
  const url=`${LASTFM_API_BASE}?${new URLSearchParams({...params,api_key:LASTFM_API_KEY,format:'json'}).toString()}`;
  const res=await fetch(url,{headers:{Accept:'application/json','User-Agent':'AlbumVault/2.0 (listening ledger)'}});
  const data=await res.json().catch(()=>({}));
  if(!res.ok || data?.error) { const error=new Error(data?.message||`Last.fm ${res.status}`); error.status=res.status; error.code=data?.error||null; throw error; }
  return data;
}
const PUBLIC_LASTFM_PARAMS = {
  'album.getinfo': ['artist','album','username','autocorrect'],
  'album.search': ['album','artist','limit','page'],
  'artist.gettopalbums': ['artist','limit','page'],
  'user.getrecenttracks': ['user','limit','page','from','to','extended']
};
function publicLastfmParams(query) {
  const method=String(query?.method||'').toLowerCase();
  const allowed=PUBLIC_LASTFM_PARAMS[method];
  if(!allowed) return null;
  const params={method};
  for(const key of allowed) {
    const value=String(query?.[key]??'').trim();
    if(value && value.length<=300) params[key]=value;
  }
  if(params.limit) params.limit=String(Math.max(1,Math.min(200,Number.parseInt(params.limit,10)||1)));
  if(params.page) params.page=String(Math.max(1,Math.min(10000,Number.parseInt(params.page,10)||1)));
  if(params.from) params.from=String(Math.max(0,Number.parseInt(params.from,10)||0));
  if(params.to) params.to=String(Math.max(0,Number.parseInt(params.to,10)||0));
  return params;
}
app.get('/lastfm', async (req,res) => {
  const params=publicLastfmParams(req.query);
  if(!params) return res.status(400).json({error:'Unsupported Last.fm method'});
  try {
    const data=await lastfmApi(params);
    res.set('Cache-Control',params.method==='user.getrecenttracks'?'no-store':'public, max-age=300');
    res.json(data);
  } catch(error) {
    res.status(Number(error.status)||502).json({error:error.code||'lastfm_error',message:String(error.message||'Last.fm request failed').slice(0,160)});
  }
});
async function validateLastfmUsername(username) {
  const data=await lastfmApi({method:'user.getinfo',user:username});
  return Boolean(data?.user?.name);
}
async function getActiveLastfmEpoch(username) {
  const rows=await sb(`lastfm_tracking_epochs?user_id=eq.${encodeURIComponent(username)}&status=eq.active&select=*&limit=1`);
  return rows?.[0] || null;
}
async function activateLastfmTracking(username, profile) {
  const configured=String(profile?.lastfmUsername||'').trim();
  const active=await getActiveLastfmEpoch(username);
  if(!configured) { if(active) await sb('rpc/lastfm_pause_active_epoch',{method:'POST',body:JSON.stringify({p_user_id:username,p_reason:'username_removed'})}); return null; }
  const timezone=normalizeIanaTimezone(profile?.timezone || active?.timezone || 'UTC');
  if(active && active.normalized_username===normalizedLastfmUsername(configured)) {
    if(active.timezone!==timezone) {
      await sb('rpc/set_user_listening_timezone',{method:'POST',body:JSON.stringify({p_user_id:username,p_timezone:timezone})});
      return getActiveLastfmEpoch(username);
    }
    return active;
  }
  await validateLastfmUsername(configured);
  const rows=await sb('rpc/lastfm_activate_epoch',{method:'POST',body:JSON.stringify({p_user_id:username,p_username:configured,p_timezone:timezone})});
  return rows?.[0] || null;
}
async function syncRunPatch(runId, patch) { if(runId) await sb(`listening_sync_runs?id=eq.${runId}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify(patch)}); }
async function startListeningSyncRun(epoch) {
  const rows=await sb('listening_sync_runs',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({epoch_id:epoch.id,user_id:epoch.user_id,status:'running',watermark_before:epoch.watermark_played_at})});
  return rows?.[0]?.id || null;
}
async function canonicalListeningIndex() {
  const [artists,groups]=await Promise.all([
    sb('music_artists?select=id,display_name,normalized_name,musicbrainz_artist_mbid&limit=5000'),
    sb('music_release_groups?select=id,artist_id,display_title,normalized_title,musicbrainz_release_group_mbid&limit=5000')
  ]);
  const artistByMbid=new Map(), artistsByName=new Map(), groupByMbid=new Map(), groupsByArtistTitle=new Map();
  for(const artist of artists||[]) { artistByMbid.set(String(artist.musicbrainz_artist_mbid),artist); const key=artist.normalized_name; if(!artistsByName.has(key)) artistsByName.set(key,[]); artistsByName.get(key).push(artist); }
  for(const group of groups||[]) { groupByMbid.set(String(group.musicbrainz_release_group_mbid),group); const key=`${group.artist_id}|${group.normalized_title}`; if(!groupsByArtistTitle.has(key)) groupsByArtistTitle.set(key,[]); groupsByArtistTitle.get(key).push(group); }
  return {artistByMbid,artistsByName,groupByMbid,groupsByArtistTitle};
}
function resolveListeningIdentity(track, index) {
  const sourceArtist=lastfmTrackText(track,'artist'), sourceAlbum=lastfmTrackText(track,'album');
  const artistMbid=safeMbId(track?.artist?.mbid), albumMbid=safeMbId(track?.album?.mbid);
  let artist=artistMbid ? index.artistByMbid.get(artistMbid) : null;
  let source=artist?'lastfm_artist_mbid_existing':null, confidence=artist?1:null;
  if(!artist) { const exact=index.artistsByName.get(AchievementRules.normText(sourceArtist))||[]; if(exact.length===1) { artist=exact[0]; source='existing_canonical_artist_exact'; confidence=.95; } else if(exact.length>1) return {artist:null,group:null,source:'ambiguous_artist',confidence:null}; }
  let group=albumMbid ? index.groupByMbid.get(albumMbid) : null;
  if(group && artist && group.artist_id!==artist.id) return {artist,group:null,source:'ambiguous_album_artist_conflict',confidence:null};
  if(group) { source='lastfm_release_group_mbid_existing'; confidence=1; }
  else if(artist && sourceAlbum) { const exact=index.groupsByArtistTitle.get(`${artist.id}|${AchievementRules.normText(sourceAlbum)}`)||[]; if(exact.length===1) { group=exact[0]; source='existing_canonical_release_group_exact'; confidence=.95; } else if(exact.length>1) return {artist,group:null,source:'ambiguous_release_group',confidence:null}; }
  return {artist,group,source:source||'unresolved',confidence};
}

// ── Phase 3A: asynchronous recording/release-track enrichment ─────────────
// Last.fm album MBIDs identify MusicBrainz releases, not release groups. The
// Phase 3 worker follows that relation explicitly and never treats a title as
// canonical identity unless it is an exact, unique match inside a verified
// MusicBrainz release tracklist.
async function fetchMusicBrainzRelease(releaseMbid) {
  return mbJson(`/release/${releaseMbid}?inc=release-groups+artists+artist-credits+recordings`);
}
async function ensureListeningArtist(scrobble) {
  if(scrobble.artist_id) return (await sb(`music_artists?id=eq.${scrobble.artist_id}&limit=1`))?.[0]||null;
  const mbid=safeMbId(scrobble.source_artist_mbid);
  if(mbid) {
    const existing=(await sb(`music_artists?musicbrainz_artist_mbid=eq.${mbid}&limit=1`))?.[0];
    if(existing) return existing;
    const artist=await mbJson(`/artist/${mbid}`);
    if(identityText(artist?.name)!==identityText(scrobble.source_artist)) throw Object.assign(new Error('artist MBID/name conflict'),{resolution:'ambiguous_artist_mbid_name_conflict'});
    return upsertCanonicalArtist({id:mbid,name:artist.name},'lastfm_artist_mbid_validated');
  }
  const rows=await sb(`music_artists?normalized_name=eq.${encodeURIComponent(identityText(scrobble.source_artist))}&limit=3`);
  if(rows?.length===1) return rows[0];
  if(rows?.length>1) throw Object.assign(new Error('ambiguous exact artist'),{resolution:'ambiguous_artist'});
  return null;
}
async function upsertMusicRelease(release, groupRow, groupArtist) {
  const releaseMbid=safeMbId(release?.id); if(!releaseMbid) throw new Error('release MBID missing');
  const tracklist=ListeningIntelligence.flattenReleaseTracklist(release);
  const title=String(release?.title||'').trim();
  const releaseRows=await sb('music_releases?on_conflict=musicbrainz_release_mbid',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify({release_group_id:groupRow.id,musicbrainz_release_mbid:releaseMbid,display_title:title,normalized_title:identityText(title),release_date:mbDate(release?.date),country:release?.country||null,status:release?.status||null,packaging:release?.packaging||null,media_formats:(release?.media||[]).map(x=>x?.format).filter(Boolean),tracklist_status:tracklist.status,duration_complete:tracklist.duration_complete,total_duration_ms:tracklist.total_duration_ms,source:'musicbrainz_release_lookup',match_confidence:1,metadata:{musicbrainz:true,medium_count:(release?.media||[]).length},updated_at:new Date().toISOString()})});
  const releaseRow=releaseRows?.[0]; if(!releaseRow) throw new Error('release upsert failed');
  const persisted=[];
  for(const item of tracklist.tracks) {
    if(!safeMbId(item.recording_mbid)||!safeMbId(item.track_mbid)) continue;
    const recordingCredit=(item.artist_credit||[]).map(x=>x?.artist).filter(Boolean);
    const singleCredit=recordingCredit.length===1?safeMbId(recordingCredit[0]?.id):null;
    const recordingArtistId=singleCredit&&singleCredit===safeMbId(groupArtist?.musicbrainz_artist_mbid)?groupArtist.id:null;
    const trackRows=await sb('music_tracks?on_conflict=musicbrainz_recording_mbid',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify({display_title:item.title,normalized_title:identityText(item.title),artist_id:recordingArtistId,artist_credit:item.artist_credit||[],musicbrainz_recording_mbid:item.recording_mbid,duration_ms:item.duration_ms,duration_source:item.duration_ms?'musicbrainz_release_track':null,duration_confidence:item.duration_ms?1:null,source:'musicbrainz_recording',match_confidence:1,metadata:{musicbrainz:true},updated_at:new Date().toISOString()})});
    const trackRow=trackRows?.[0]; if(!trackRow) continue;
    const releaseTrackRows=await sb('music_release_tracks?on_conflict=musicbrainz_track_mbid',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify({release_id:releaseRow.id,track_id:trackRow.id,musicbrainz_track_mbid:item.track_mbid,display_title:item.title,normalized_title:identityText(item.title),medium_position:item.medium_position,track_position:item.position,absolute_position:item.absolute_position,duration_ms:item.duration_ms,duration_source:item.duration_ms?'musicbrainz_release_track':null,duration_confidence:item.duration_ms?1:null,source:'musicbrainz_release_track',match_confidence:1,metadata:{recording_mbid:item.recording_mbid},updated_at:new Date().toISOString()})});
    if(releaseTrackRows?.[0]) persisted.push({...releaseTrackRows[0],musicbrainz_recording_mbid:item.recording_mbid});
  }
  return {release:releaseRow,tracklist:{...tracklist,tracks:persisted}};
}
async function ensureReleaseGroupForRelease(release, artistHint) {
  let group=release?.['release-group'];
  const groupMbid=safeMbId(group?.id); if(!groupMbid) throw Object.assign(new Error('release lacks release group'),{resolution:'release_without_release_group'});
  if(!group?.['artist-credit']) group=await mbJson(`/release-group/${groupMbid}?inc=artists`);
  const credit=mbArtistCredit(group)||mbArtistCredit(release);
  if(!credit) throw Object.assign(new Error('ambiguous release artist credit'),{resolution:'ambiguous_release_artist_credit'});
  if(artistHint&&safeMbId(artistHint.musicbrainz_artist_mbid)!==credit.mbid) throw Object.assign(new Error('album/artist conflict'),{resolution:'ambiguous_album_artist_conflict'});
  const artist=artistHint||await upsertCanonicalArtist({id:credit.mbid,name:credit.name},'musicbrainz_release_credit');
  const groupRow=await upsertCanonicalReleaseGroup(group,artist,'musicbrainz_release_relation',1);
  return {groupRow,artist};
}
async function ensureObservedRelease(scrobble, artistHint) {
  const releaseMbid=safeMbId(scrobble.source_album_mbid); if(!releaseMbid) return null;
  const cached=(await sb(`music_releases?musicbrainz_release_mbid=eq.${releaseMbid}&limit=1`))?.[0];
  if(cached) {
    const group=(await sb(`music_release_groups?id=eq.${cached.release_group_id}&limit=1`))?.[0];
    const artist=group?(await sb(`music_artists?id=eq.${group.artist_id}&limit=1`))?.[0]:artistHint;
    const tracks=await sb(`music_release_tracks?release_id=eq.${cached.id}&order=absolute_position.asc`);
    return {release:cached,groupRow:group,artist,tracks:tracks||[]};
  }
  const release=await fetchMusicBrainzRelease(releaseMbid);
  // A verified Release MBID is stronger album evidence than Last.fm's artist
  // MBID, which is frequently missing or points at a same-name artist. The
  // release group's own artist credit is authoritative for album identity.
  const {groupRow,artist}=await ensureReleaseGroupForRelease(release,null);
  const persisted=await upsertMusicRelease(release,groupRow,artist);
  return {release:persisted.release,groupRow,artist,tracks:persisted.tracklist.tracks};
}
async function ensureStrictListeningGroup(scrobble, artistHint) {
  const found=await findStrictReleaseGroup({title:scrobble.source_album,artist:scrobble.source_artist});
  if(found.status!=='resolved') throw Object.assign(new Error(found.note||'album unresolved'),{resolution:found.status==='ambiguous'?'ambiguous_release_group':'musicbrainz_no_unequivocal_album_match',retry:found.status!=='ambiguous'});
  const credit=mbArtistCredit(found.group); if(!credit) throw Object.assign(new Error('ambiguous group credit'),{resolution:'ambiguous_release_artist_credit'});
  if(artistHint&&safeMbId(artistHint.musicbrainz_artist_mbid)!==credit.mbid) throw Object.assign(new Error('group artist conflict'),{resolution:'ambiguous_album_artist_conflict'});
  const artist=artistHint||await upsertCanonicalArtist({id:credit.mbid,name:credit.name},'musicbrainz_strict_exact_metadata');
  return {groupRow:await upsertCanonicalReleaseGroup(found.group,artist,found.source,found.confidence),artist};
}
async function ensureRepresentativeRelease(groupRow, artist, observed) {
  const current=(await sb(`music_release_group_representatives?release_group_id=eq.${groupRow.id}&limit=1`))?.[0];
  if(current) {
    const release=(await sb(`music_releases?id=eq.${current.release_id}&limit=1`))?.[0];
    const tracks=release?await sb(`music_release_tracks?release_id=eq.${release.id}&order=absolute_position.asc`):[];
    if(release?.tracklist_status==='complete') return {release,tracks:tracks||[],evidence:current.selection_evidence};
  }
  const mbid=safeMbId(groupRow.musicbrainz_release_group_mbid);
  const data=await mbJson(`/release?release-group=${mbid}&limit=100&inc=media`);
  const candidates=data?.releases||[];
  if(observed&&!candidates.some(x=>safeMbId(x.id)===safeMbId(observed.release?.musicbrainz_release_mbid))) candidates.push({id:observed.release.musicbrainz_release_mbid,title:observed.release.display_title,status:observed.release.status,date:observed.release.release_date,media:(observed.release.media_formats||[]).map(format=>({format}))});
  const chosen=ListeningIntelligence.chooseRepresentativeRelease(candidates,{title:groupRow.display_title,first_release_date:groupRow.first_release_date});
  if(!chosen) throw Object.assign(new Error('no representative release'),{resolution:'representative_release_unavailable',retry:true});
  let detailed;
  if(observed&&safeMbId(observed.release?.musicbrainz_release_mbid)===safeMbId(chosen.release.id)&&observed.tracks?.length) detailed={release:observed.release,tracklist:{tracks:observed.tracks,status:observed.release.tracklist_status,duration_complete:observed.release.duration_complete,total_duration_ms:observed.release.total_duration_ms}};
  else detailed=await upsertMusicRelease(await fetchMusicBrainzRelease(chosen.release.id),groupRow,artist);
  const rows=await sb('music_release_group_representatives?on_conflict=release_group_id',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify({release_group_id:groupRow.id,release_id:detailed.release.id,selection_version:ListeningIntelligence.VERSION,selection_source:'musicbrainz_ranked_release_candidates',selection_evidence:chosen.evidence,selected_at:new Date().toISOString(),updated_at:new Date().toISOString()})});
  return {release:detailed.release,tracks:detailed.tracklist.tracks||[],evidence:rows?.[0]?.selection_evidence||chosen.evidence};
}
async function finishEnrichmentJob(job,status,reason,error=null,retryMs=null) {
  const body={status,locked_until:null,resolution_reason:reason||null,last_error:error?String(error.message||error).slice(0,300):null,updated_at:new Date().toISOString()};
  if(retryMs) body.next_attempt_at=new Date(Date.now()+retryMs).toISOString();
  await sb(`listening_enrichment_jobs?scrobble_id=eq.${job.scrobble_id}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify(body)});
}
async function enrichListeningScrobble(job) {
  const scrobble=(await sb(`listening_scrobbles?id=eq.${job.scrobble_id}&limit=1`))?.[0]; if(!scrobble) return null;
  try {
    let artist=await ensureListeningArtist(scrobble), observed=null, groupRow=null;
    if(scrobble.source_album_mbid) { observed=await ensureObservedRelease(scrobble,artist); groupRow=observed?.groupRow; artist=observed?.artist||artist; }
    else if(scrobble.source_album) { const strict=await ensureStrictListeningGroup(scrobble,artist); groupRow=strict.groupRow; artist=strict.artist; }
    if(!groupRow) throw Object.assign(new Error('album missing'),{resolution:scrobble.source_album?'release_group_unresolved':'missing_album'});
    const representative=await ensureRepresentativeRelease(groupRow,artist,observed);
    const sourceTrackMbid=safeMbId(scrobble.source_track_mbid);
    let match=null;
    if(sourceTrackMbid) {
      const canonical=(await sb(`music_tracks?musicbrainz_recording_mbid=eq.${sourceTrackMbid}&limit=1`))?.[0];
      if(canonical) {
        const links=representative.tracks.filter(x=>x.track_id===canonical.id);
        if(links.length===1) match={status:'resolved',track:links[0]};
      }
    }
    if(!match) match=ListeningIntelligence.exactReleaseTrackMatch(scrobble.source_track,representative.tracks);
    if(match.status!=='resolved'&&observed?.tracks?.length) match=ListeningIntelligence.exactReleaseTrackMatch(scrobble.source_track,observed.tracks);
    const releaseTrack=match.status==='resolved'?match.track:null;
    const track=releaseTrack?(await sb(`music_tracks?id=eq.${releaseTrack.track_id}&limit=1`))?.[0]:null;
    const status=track?'resolved':match.status;
    const reason=track?'musicbrainz_release_track_exact':match.reason;
    await sb('rpc/listening_reconcile_scrobble_identity',{method:'POST',body:JSON.stringify({p_scrobble_id:scrobble.id,p_artist_id:artist?.id||null,p_release_group_id:groupRow.id,p_track_id:track?.id||null,p_release_track_id:releaseTrack?.id||null,p_status:status,p_reason:reason,p_match_source:track?'musicbrainz_release_track_exact':'musicbrainz_release_resolved_track_unresolved',p_match_confidence:track?1:.9,p_metadata:{release_mbid:observed?.release?.musicbrainz_release_mbid||null,representative_release_id:representative.release.id,representative_evidence:representative.evidence}})});
    await finishEnrichmentJob(job,status,reason);
    return {...scrobble,artist_id:artist?.id||null,release_group_id:groupRow.id,track_id:track?.id||null,release_track_id:releaseTrack?.id||null,enrichment_status:status};
  } catch(error) {
    const classified=classifyEnrichmentError(error), {status,reason}=classified;
    const delay=classified.retryable?retryDelayMs(job.attempts,error.retryAfterMs):null;
    const metadata={last_error:String(error.message||error).slice(0,160),error_category:classified.category,retryable:classified.retryable};
    if(status==='failed') {
      await sb(`listening_scrobbles?id=eq.${scrobble.id}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({enrichment_status:status,enrichment_reason:reason,enrichment_metadata:metadata,enriched_at:new Date().toISOString()})}).catch(()=>{});
    } else {
      await sb('rpc/listening_reconcile_scrobble_identity',{method:'POST',body:JSON.stringify({p_scrobble_id:scrobble.id,p_artist_id:scrobble.artist_id,p_release_group_id:scrobble.release_group_id,p_track_id:scrobble.track_id,p_release_track_id:scrobble.release_track_id,p_status:status,p_reason:reason,p_match_source:scrobble.match_source,p_match_confidence:scrobble.match_confidence,p_metadata:metadata})}).catch(()=>{});
    }
    await finishEnrichmentJob(job,status,reason,error,delay);
    return {...scrobble,enrichment_status:status,enrichment_reason:reason};
  }
}
async function projectTrackBursts(username,trackIds,timezone) {
  for(const trackId of new Set((trackIds||[]).filter(Boolean))) {
    const rows=await sb(`listening_scrobbles?user_id=eq.${encodeURIComponent(username)}&track_id=eq.${trackId}&select=id,track_id,played_at&order=played_at.asc&limit=10000`);
    const window=ListeningIntelligence.rollingTrackWindow(rows||[]); if(!window) continue;
    await sb('listening_track_bursts?on_conflict=user_id,track_id,window_start',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=minimal'},body:JSON.stringify({user_id:username,track_id:trackId,window_start:window[0].played_at,window_end:window.at(-1).played_at,scrobble_ids:window.map(x=>x.id),timestamps:window.map(x=>x.played_at),timezone,projection_version:ListeningIntelligence.VERSION})});
  }
}
async function rebuildListeningProjections(username,affectedRows) {
  const dated=(affectedRows||[]).filter(x=>Number.isFinite(Date.parse(x.played_at))); if(!dated.length) return {sessions:0,runs:0};
  const epoch=await getActiveLastfmEpoch(username); if(!epoch) return {sessions:0,runs:0};
  const from=new Date(Math.min(...dated.map(x=>Date.parse(x.played_at)))-36*3600000).toISOString();
  const [rows,coverage]=await Promise.all([
    sb(`listening_scrobbles?user_id=eq.${encodeURIComponent(username)}&played_at=gte.${encodeURIComponent(from)}&select=id,epoch_id,artist_id,release_group_id,track_id,source_artist,source_track,played_at,local_date&order=played_at.asc&limit=5000`),
    sb(`listening_coverage_windows?user_id=eq.${encodeURIComponent(username)}&coverage_end=gte.${encodeURIComponent(from)}&select=coverage_start,coverage_end,status`)
  ]);
  const groupIds=[...new Set((rows||[]).map(x=>x.release_group_id).filter(Boolean))];
  const representatives=groupIds.length?await sb(`music_release_group_representatives?release_group_id=in.(${groupIds.join(',')})&select=release_group_id,release_id,selection_version,selection_evidence`):[];
  const releaseIds=(representatives||[]).map(x=>x.release_id);
  const releases=releaseIds.length?await sb(`music_releases?id=in.(${releaseIds.join(',')})&select=id,release_group_id,tracklist_status,duration_complete,total_duration_ms,display_title`):[];
  const releaseTracks=releaseIds.length?await sb(`music_release_tracks?release_id=in.(${releaseIds.join(',')})&select=id,release_id,track_id,absolute_position,duration_ms,display_title&order=absolute_position.asc`):[];
  const repByGroup=new Map((representatives||[]).map(x=>[x.release_group_id,x])), releaseById=new Map((releases||[]).map(x=>[x.id,x])), tracksByRelease=new Map();
  for(const item of releaseTracks||[]) { if(!tracksByRelease.has(item.release_id))tracksByRelease.set(item.release_id,[]); tracksByRelease.get(item.release_id).push(item); }
  const tracklists={};
  for(const groupId of groupIds) { const rep=repByGroup.get(groupId), release=rep&&releaseById.get(rep.release_id), tracks=release?tracksByRelease.get(release.id)||[]:[]; if(release) tracklists[groupId]={release_id:release.id,status:release.tracklist_status,duration_complete:release.duration_complete,total_duration_ms:Number(release.total_duration_ms),tracks,evidence:rep.selection_evidence}; }
  const projected=(rows||[]).map(row=>{ const list=tracklists[row.release_group_id], matches=list?.tracks?.filter(x=>x.track_id===row.track_id)||[], link=matches.length===1?matches[0]:null; return {...row,representative_position:link?.absolute_position||null,duration_ms:link?.duration_ms||null}; });
  const sessions=ListeningIntelligence.buildSessions(projected,coverage||[]);
  const runs=ListeningIntelligence.detectAlbumRuns(projected,tracklists,coverage||[]);
  await sb(`listening_session_items?session_id=in.(${(await sb(`listening_sessions?user_id=eq.${encodeURIComponent(username)}&started_at=gte.${encodeURIComponent(from)}&select=id`)).map(x=>x.id).join(',')||'00000000-0000-0000-0000-000000000000'})`,{method:'DELETE',headers:{Prefer:'return=minimal'}}).catch(()=>{});
  await sb(`listening_sessions?user_id=eq.${encodeURIComponent(username)}&started_at=gte.${encodeURIComponent(from)}`,{method:'DELETE',headers:{Prefer:'return=minimal'}});
  await sb(`listening_album_runs?user_id=eq.${encodeURIComponent(username)}&started_at=gte.${encodeURIComponent(from)}`,{method:'DELETE',headers:{Prefer:'return=minimal'}});
  for(const session of sessions) {
    const fingerprint=sha256([username,...session.items.map(x=>x.id),ListeningIntelligence.VERSION].join('|'));
    const inserted=await sb('listening_sessions?on_conflict=user_id,session_fingerprint',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify({user_id:username,epoch_id:session.items[0].epoch_id,started_at:session.started_at,ended_at:session.ended_at,started_at_is_derived:session.started_at_is_derived,item_count:session.items.length,identity_status:session.identity_status,duration_status:session.duration_status,coverage_status:session.coverage_status,projection_version:ListeningIntelligence.VERSION,session_fingerprint:fingerprint,metadata:{algorithm:'projected-silence-v1'}})});
    const sessionId=inserted?.[0]?.id;
    if(sessionId) await sb('listening_session_items',{
      method:'POST',headers:{Prefer:'return=minimal'},
      body:JSON.stringify(session.items.map((x,i)=>({session_id:sessionId,scrobble_id:x.id,item_position:i+1,projected_start_at:Number(x.duration_ms)>0?new Date(Date.parse(x.played_at)-Number(x.duration_ms)).toISOString():null})))
    });
  }
  const groups=groupIds.length?await sb(`music_release_groups?id=in.(${groupIds.join(',')})&select=id,display_title,musicbrainz_release_group_mbid,music_artists(display_name)`):[];
  const groupById=new Map((groups||[]).map(x=>[x.id,x]));
  for(const run of runs) {
    const group=groupById.get(run.release_group_id)||{};
    const fingerprint=sha256([username,run.release_group_id,...run.scrobble_ids,ListeningIntelligence.VERSION].join('|'));
    const tracklist=tracklists[run.release_group_id];
    const evidence={...run,release_group:{id:run.release_group_id,mbid:group.musicbrainz_release_group_mbid||null,title:group.display_title||'',artist:group.music_artists?.display_name||''},tracklist_evidence:tracklist?.evidence||null,session_evidence:{algorithm:'projected-silence-v1',coverage:'covered'}};
    await sb('listening_album_runs?on_conflict=user_id,run_fingerprint',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({user_id:username,epoch_id:epoch.id,release_group_id:run.release_group_id,release_id:run.release_id,local_date:run.local_date,started_at:run.started_at,ended_at:run.ended_at,inferred_start:run.inferred_start,elapsed_ms:run.elapsed_ms,album_duration_ms:run.total_duration_ms,track_count:run.track_count,foreign_scrobble_count:run.foreign_scrobble_count,qualifies_dash:run.qualifies_dash,run_fingerprint:fingerprint,evidence,projection_version:ListeningIntelligence.VERSION})});
  }
  await projectTrackBursts(username,dated.map(x=>x.track_id),epoch.timezone);
  return {sessions:sessions.length,runs:runs.length};
}
async function runListeningEnrichmentBatch(limit=3) {
  const jobs=await sb('rpc/claim_listening_enrichment_jobs',{method:'POST',body:JSON.stringify({p_limit:limit})});
  const affectedByUser=new Map(), results=[];
  for(const job of jobs||[]) {
    const result=await enrichListeningScrobble(job); results.push(result);
    if(result) { if(!affectedByUser.has(result.user_id))affectedByUser.set(result.user_id,[]); affectedByUser.get(result.user_id).push(result); }
  }
  const projections=[];
  for(const [username,rows] of affectedByUser) { projections.push({user_id:username,...await rebuildListeningProjections(username,rows)}); await evaluateListeningAchievements(username,'listening_enrichment'); await evaluateDiscoveryListeningAchievements(username,'listening_enrichment'); }
  return {processed:results.length,resolved:results.filter(x=>x?.enrichment_status==='resolved').length,projections};
}
function overlapCoverage(rows,start,end) {
  const intervals=(rows||[]).filter(x=>x.status==='covered'&&Date.parse(x.coverage_end)>start&&Date.parse(x.coverage_start)<end).map(x=>[Math.max(start,Date.parse(x.coverage_start)),Math.min(end,Date.parse(x.coverage_end))]).sort((a,b)=>a[0]-b[0]);
  let total=0,last=null; for(const range of intervals){ if(!last||range[0]>last[1]) { if(last) total+=last[1]-last[0]; last=[...range]; } else last[1]=Math.max(last[1],range[1]); } if(last) total+=last[1]-last[0]; return Math.max(0,Math.min(1,total/Math.max(1,end-start)));
}
async function listeningEvaluationInput(username) {
  const now=Date.now(), sevenDays=now-7*86400000;
  const [artists,releases,hours,dailyReleases,coverage,recent,trackCounts,bursts,albumRuns,epoch]=await Promise.all([
    sb(`listening_lifetime_artist_counts?user_id=eq.${encodeURIComponent(username)}&select=artist_id,scrobble_count,music_artists!inner(display_name,musicbrainz_artist_mbid)&order=scrobble_count.desc&limit=100`),
    sb(`listening_lifetime_release_group_counts?user_id=eq.${encodeURIComponent(username)}&select=release_group_id,scrobble_count,music_release_groups!inner(display_title,musicbrainz_release_group_mbid,music_artists!inner(display_name))&order=scrobble_count.desc&limit=100`),
    sb(`listening_hour_totals?user_id=eq.${encodeURIComponent(username)}&local_hour=lt.5&select=local_date,local_hour,scrobble_count`),
    sb(`listening_daily_release_group_counts?user_id=eq.${encodeURIComponent(username)}&select=local_date,release_group_id,scrobble_count,music_release_groups!inner(display_title,musicbrainz_release_group_mbid,music_artists!inner(display_name))&order=local_date.asc&limit=5000`),
    sb(`listening_coverage_windows?user_id=eq.${encodeURIComponent(username)}&select=coverage_start,coverage_end,status`),
    sb(`listening_scrobbles?user_id=eq.${encodeURIComponent(username)}&played_at=gte.${encodeURIComponent(new Date(sevenDays).toISOString())}&select=played_at,release_group_id&order=played_at.asc&limit=5000`),
    sb(`listening_lifetime_track_counts?user_id=eq.${encodeURIComponent(username)}&select=track_id,scrobble_count,music_tracks!inner(display_title,musicbrainz_recording_mbid,music_artists(display_name))&order=scrobble_count.desc&limit=100`),
    sb(`listening_track_bursts?user_id=eq.${encodeURIComponent(username)}&select=track_id,timestamps,window_start,window_end&order=window_start.asc&limit=20`),
    sb(`listening_album_runs?user_id=eq.${encodeURIComponent(username)}&select=release_group_id,release_id,local_date,started_at,ended_at,elapsed_ms,album_duration_ms,foreign_scrobble_count,qualifies_dash,evidence&order=started_at.asc&limit=200`),
    getActiveLastfmEpoch(username)
  ]);
  const artistRows=(artists||[]).map(x=>({...x,...(x.music_artists||{})}));
  const releaseRows=(releases||[]).map(x=>({...x,...(x.music_release_groups||{}),artist_name:x.music_release_groups?.music_artists?.display_name||''}));
  const lucid={scrobbles:(hours||[]).reduce((n,x)=>n+Number(x.scrobble_count||0),0),days:[...new Set((hours||[]).filter(x=>Number(x.scrobble_count)>0).map(x=>x.local_date))]};
  const byRelease=new Map(); for(const row of dailyReleases||[]) { const key=row.release_group_id; if(!byRelease.has(key)) byRelease.set(key,{release_group_id:key,display_title:row.music_release_groups?.display_title||'',musicbrainz_release_group_mbid:row.music_release_groups?.musicbrainz_release_group_mbid||null,artist_name:row.music_release_groups?.music_artists?.display_name||'',days:[],counts:new Map()}); const item=byRelease.get(key); item.days.push(row.local_date); item.counts.set(row.local_date,Number(row.scrobble_count||0)); }
  const magnetic=[...byRelease.values()].map(row=>{ const streak=ListeningRules.maxConsecutive(row.days); return {...row,streak_scrobbles:streak.reduce((n,d)=>n+(row.counts.get(d)||0),0)}; });
  const coveragePercent=overlapCoverage(coverage,sevenDays,now), byRecentRelease=new Map(); for(const row of recent||[]) if(row.release_group_id) byRecentRelease.set(row.release_group_id,(byRecentRelease.get(row.release_group_id)||0)+1);
  const totalRecent=(recent||[]).length; let hyperfixation=null; for(const [release_group_id,album_count] of byRecentRelease){ if(!hyperfixation||album_count>hyperfixation.album_count){ const r=releaseRows.find(x=>x.release_group_id===release_group_id)||{}; hyperfixation={release_group:{id:release_group_id,mbid:r.musicbrainz_release_group_mbid||null,title:r.display_title||'',artist:r.artist_name||''},release_group_id,album_count,total:totalRecent,coverage:coveragePercent,window_start:new Date(sevenDays).toISOString(),window_end:new Date(now).toISOString()}; } }
  const trackRows=(trackCounts||[]).map(x=>({...x,...(x.music_tracks||{}),artist_name:x.music_tracks?.music_artists?.display_name||''}));
  const trackById=Object.fromEntries(trackRows.map(x=>[x.track_id,x]));
  const burstTracks=[]; for(const burst of bursts||[]) (burst.timestamps||[]).forEach((played_at,index)=>burstTracks.push({id:`${burst.track_id}:${index}:${played_at}`,track_id:burst.track_id,played_at}));
  const runRows=(albumRuns||[]).map(row=>({...row,...(row.evidence||{}),total_duration_ms:Number(row.album_duration_ms),track_timestamps:row.evidence?.track_timestamps||row.evidence?.tracks||[]}));
  return {artists:artistRows,releaseGroups:releaseRows,lucidDream:lucid,magnetic,hyperfixation,trackCounts:trackRows,trackById,tracks:burstTracks,albumRuns:runRows,timezone:epoch?.timezone||'UTC'};
}
async function temporalListeningEvaluationInput(username) {
  const epoch=await getActiveLastfmEpoch(username); if(!epoch)return {periods:[]};
  const now=new Date().toISOString();
  const [raw,periods]=await Promise.all([
    sb('rpc/achievement_temporal_listening_evidence',{method:'POST',body:JSON.stringify({p_user_id:username,p_epoch_id:epoch.id,p_now:now})}),
    sb(`listening_period_snapshots?user_id=eq.${encodeURIComponent(username)}&epoch_id=eq.${epoch.id}&select=id,period_type,local_start,local_end,utc_start,utc_end,timezone,coverage_ratio,coverage_continuous,completeness,scrobble_total,rankings,snapshot_version&order=local_start.asc&limit=1000`)
  ]);
  const evidence=Array.isArray(raw)?raw[0]:raw,window30=evidence?.window30||{},window60=evidence?.window60||{};
  const groupIds=[...new Set((evidence?.lost_found||[]).map(row=>row.release_group_id).filter(Boolean))];
  const groups=groupIds.length?await sb(`music_release_groups?id=in.(${groupIds.join(',')})&select=id,display_title,musicbrainz_release_group_mbid,music_artists!inner(display_name)`):[];
  const groupById=new Map((groups||[]).map(row=>[row.id,row]));
  const artists=(evidence?.artists||[]).map(row=>({...row,epoch_id:epoch.id,window_start:window30.start,window_end:window30.end,coverage_continuous:Boolean(window30.continuous),identity_complete:Boolean(window30.identity_complete),artist:{id:row.artist_id,mbid:row.musicbrainz_artist_mbid||null,name:row.display_name||''}}));
  const lostAndFound=(evidence?.lost_found||[]).map(row=>{const group=groupById.get(row.release_group_id);return {...row,epoch_id:epoch.id,same_epoch:true,identity_complete:Boolean(group?.musicbrainz_release_group_mbid),release_group:{id:row.release_group_id,mbid:group?.musicbrainz_release_group_mbid||null,title:group?.display_title||'',artist:group?.music_artists?.display_name||''}};});
  return {periods:periods||[],nightShift:artists,allRoads:artists,timeTraveler:{epoch_id:epoch.id,window_start:window30.start,window_end:window30.end,coverage_continuous:Boolean(window30.continuous),identity_complete:Boolean(window30.identity_complete),decade_tracks:evidence?.decade_tracks||{}},fromDusk:{epoch_id:epoch.id,timezone:epoch.timezone,window_start:window60.start,window_end:window60.end,coverage_continuous:Boolean(window60.continuous),hour_counts:evidence?.hour_counts||{}},lostAndFound};
}
async function refreshListeningRecords(username, input) {
  const artist=(input.artists||[])[0], album=(input.releaseGroups||[])[0], track=(input.trackCounts||[])[0];
  const hourRows=await sb(`listening_hour_totals?user_id=eq.${encodeURIComponent(username)}&select=local_hour,scrobble_count&order=scrobble_count.desc&limit=24`);
  const dominant=(hourRows||[]).sort((a,b)=>Number(b.scrobble_count)-Number(a.scrobble_count))[0];
  const now=new Date().toISOString(), rows=[];
  if(artist) rows.push({user_id:username,record_key:'most_played_artist',value:{artist:{id:artist.artist_id,name:artist.display_name,mbid:artist.musicbrainz_artist_mbid||null},scrobbles:Number(artist.scrobble_count)},observed_at:now,updated_at:now});
  if(album) rows.push({user_id:username,record_key:'most_played_album',value:{release_group:{id:album.release_group_id,title:album.display_title,artist:album.artist_name,mbid:album.musicbrainz_release_group_mbid||null},scrobbles:Number(album.scrobble_count)},observed_at:now,updated_at:now});
  if(track) rows.push({user_id:username,record_key:'most_replayed_track',value:{track:{id:track.track_id,title:track.display_title,artist:track.artist_name,mbid:track.musicbrainz_recording_mbid||null},scrobbles:Number(track.scrobble_count)},observed_at:now,updated_at:now});
  if(dominant) rows.push({user_id:username,record_key:'dominant_listening_hour',value:{local_hour:Number(dominant.local_hour),scrobbles:Number(dominant.scrobble_count)},observed_at:now,updated_at:now});
  if(rows.length) await sb('vault_personal_records?on_conflict=user_id,record_key',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(rows)});
}
async function evaluateListeningAchievements(username, source='lastfm_sync') {
  await ensureAchievementDefinitions();
  const [input,temporalInput]=await Promise.all([listeningEvaluationInput(username),temporalListeningEvaluationInput(username)]), evaluation=ListeningRules.evaluate(input),temporal=TemporalListeningRules.evaluate(temporalInput);
  await writeProgress(username,[...evaluation.progress,...temporal.progress]);
  await refreshListeningRecords(username,input);
  const listeningUnlocks=await persistAchievementCandidates(username,[...evaluation.candidates,...temporal.candidates],source,new Date().toISOString());
  const hybridUnlocks=await evaluateHybridAchievements(username,source);
  const all=[...listeningUnlocks,...hybridUnlocks]; if(all.length){await syncCosmeticEntitlements(username);await refreshEmblemState(username);}
  return all;
}

function eventAlbumId(event) { return String(event?.payload?.album_id||AchievementRules.albumId(event?.payload?.album)||''); }
function eventScoreValue(event) { return AchievementRules.score(event?.payload?.new_score??event?.payload?.score??event?.payload?.album?.score); }
async function hybridEvaluationInput(username) {
  const [state,epoch,events,periods]=await Promise.all([
    getAchievementState(username),getActiveLastfmEpoch(username),getAchievementEvents(username),
    sb(`listening_period_snapshots?user_id=eq.${encodeURIComponent(username)}&select=id,epoch_id,period_type,local_start,local_end,utc_start,utc_end,timezone,coverage_ratio,completeness,scrobble_total,rankings,snapshot_version,closed_at&order=local_start.asc&limit=1000`).catch(()=>[])
  ]);
  if(!state?.achievement_tracking_started_at||!epoch)return {albums:[],artists:[],coverage:[],periods,epoch_id:epoch?.id||null,now:new Date().toISOString()};
  const eligible=AchievementRules.eligibleAfter(events,state.achievement_tracking_started_at).filter(e=>e.type!=='identity_resolved');
  const albumIds=[...new Set(eligible.map(eventAlbumId).filter(Boolean))];
  const identities=albumIds.length?await sb(`vault_album_identities?user_id=eq.${encodeURIComponent(username)}&status=eq.resolved&album_id=in.(${albumIds.map(encodeURIComponent).join(',')})&select=album_id,status,artist_id,release_group_id`):[];
  const identityByAlbum=new Map((identities||[]).map(x=>[String(x.album_id),x]));
  const groupIds=[...new Set((identities||[]).map(x=>x.release_group_id).filter(Boolean))];
  const groups=groupIds.length?await sb(`music_release_groups?id=in.(${groupIds.join(',')})&select=id,artist_id,display_title,musicbrainz_release_group_mbid,music_artists!inner(id,display_name,musicbrainz_artist_mbid)`):[];
  const groupById=new Map((groups||[]).map(x=>[x.id,x])), artistIds=[...new Set((groups||[]).map(x=>x.artist_id).filter(Boolean))];
  const [releaseCounts,artistCounts,trackCounts,reps]=await Promise.all([
    groupIds.length?sb(`listening_lifetime_release_group_counts?user_id=eq.${encodeURIComponent(username)}&release_group_id=in.(${groupIds.join(',')})&select=release_group_id,scrobble_count,last_played_at`):[],
    artistIds.length?sb(`listening_lifetime_artist_counts?user_id=eq.${encodeURIComponent(username)}&artist_id=in.(${artistIds.join(',')})&select=artist_id,scrobble_count`):[],
    sb(`listening_lifetime_track_counts?user_id=eq.${encodeURIComponent(username)}&select=track_id,scrobble_count,music_tracks!inner(musicbrainz_recording_mbid)&limit=1000`),
    groupIds.length?sb(`music_release_group_representatives?release_group_id=in.(${groupIds.join(',')})&select=release_group_id,release_id`):[]
  ]);
  const releaseByGroup=new Map((reps||[]).map(x=>[x.release_group_id,x.release_id]));
  const releaseIds=[...new Set(releaseByGroup.values())];
  const releaseTracks=releaseIds.length?await sb(`music_release_tracks?release_id=in.(${releaseIds.join(',')})&select=release_id,track_id,display_title,normalized_title,music_tracks!inner(musicbrainz_recording_mbid)&limit=5000`):[];
  const releaseCountById=new Map((releaseCounts||[]).map(x=>[x.release_group_id,{count:Number(x.scrobble_count),last:x.last_played_at}])), artistCountById=new Map((artistCounts||[]).map(x=>[x.artist_id,Number(x.scrobble_count)])), trackCountById=new Map((trackCounts||[]).map(x=>[x.track_id,{count:Number(x.scrobble_count),mbid:x.music_tracks?.musicbrainz_recording_mbid||null}]));
  const albums=[];
  for(const albumId of albumIds) {
    const identity=identityByAlbum.get(albumId), group=identity&&groupById.get(identity.release_group_id); if(!identity||!group)continue;
    const timeline=eligible.filter(e=>eventAlbumId(e)===albumId).sort((a,b)=>Date.parse(a.occurred_at)-Date.parse(b.occurred_at));
    const ratings=timeline.filter(e=>e.type==='album_rated'),rescoreEvents=timeline.filter(e=>e.type==='album_rescored'),scoreEvents=timeline.filter(e=>['album_rated','album_rescored'].includes(e.type)&&eventScoreValue(e)!==null),latest=scoreEvents.at(-1),initial=ratings[0];
    const trackEvent=timeline.filter(e=>e.type==='track_scores_saved').at(-1), rawScores=Object.entries(trackEvent?.payload?.album?.trackScores||{});
    const releaseId=releaseByGroup.get(group.id), canonicalTracks=(releaseTracks||[]).filter(x=>x.release_id===releaseId);
    const trackScores=rawScores.map(([title,value])=>{ const normalized=ListeningIntelligence.normalize(title),matches=canonicalTracks.filter(x=>x.normalized_title===normalized),match=matches.length===1?matches[0]:null,count=match&&trackCountById.get(match.track_id); return {title,score:AchievementRules.score(value),track_id:match?.track_id||null,recording_mbid:count?.mbid||match?.music_tracks?.musicbrainz_recording_mbid||null,scrobble_count:count?.count||0,match_status:match?'canonical_release_exact':matches.length>1?'ambiguous':'unresolved'}; });
    const releaseCount=releaseCountById.get(group.id)||{count:0,last:null};
    albums.push({album_id:albumId,canonical:true,release_group_id:group.id,artist_id:group.artist_id,release_group:{id:group.id,mbid:group.musicbrainz_release_group_mbid,title:group.display_title,artist:group.music_artists?.display_name||''},initial_rating:initial?{score:eventScoreValue(initial),at:initial.occurred_at}:null,current_score:latest?eventScoreValue(latest):null,current_score_at:latest?.occurred_at||null,current_tier:latest?AchievementRules.tier(eventScoreValue(latest)):null,rescores:rescoreEvents.map(e=>({at:e.occurred_at,before:AchievementRules.score(e.payload?.previous_score),after:eventScoreValue(e),delta:AchievementRules.score(e.payload?.delta??(eventScoreValue(e)-Number(e.payload?.previous_score)))})),reviews:timeline.filter(e=>['review_written','review_updated'].includes(e.type)).map(e=>({at:e.occurred_at,char_count:Number(e.payload?.review_char_count||0),substantial:Boolean(e.payload?.substantial),excerpt:e.payload?.excerpt||null})),track_scores:trackScores,total_scrobbles:releaseCount.count,last_played_at:releaseCount.last,scrobbles:[],metrics:{}});
  }
  const metricWindows=[];
  for(const album of albums) {
    const add=(name,after,before=null)=>metricWindows.push({key:`${album.album_id}:${name}`,release_group_id:album.release_group_id,after,before});
    if(album.initial_rating) { add('initial_after',album.initial_rating.at); add('initial_30d',album.initial_rating.at,new Date(Date.parse(album.initial_rating.at)+30*86400000).toISOString()); }
    if(album.current_score_at)add('current_after',album.current_score_at);
    for(const [index,rescore] of album.rescores.entries()) { add(`rescore_after_${index}`,rescore.at); if(album.initial_rating)add(`initial_to_rescore_${index}`,album.initial_rating.at,rescore.at); }
  }
  const metricRows=metricWindows.length?await sb('rpc/hybrid_count_scrobble_windows',{method:'POST',body:JSON.stringify({p_user_id:username,p_epoch_id:epoch.id,p_windows:metricWindows})}).catch(()=>[]):[];
  const metricByKey=new Map((metricRows||[]).map(x=>[x.metric_key,{count:Number(x.scrobble_count||0),first:x.first_played_at,last:x.last_played_at}]));
  for(const album of albums) for(const window of metricWindows.filter(x=>x.key.startsWith(`${album.album_id}:`))) album.metrics[window.key.slice(album.album_id.length+1)]=metricByKey.get(window.key)||{count:0,first:null,last:null};
  const nowIso=new Date().toISOString(),coverageWindows=[];
  for(const album of albums) {
    const add=(name,start,end)=>coverageWindows.push({key:`${album.album_id}:${name}`,start,end});
    if(album.initial_rating) { add('initial_30d',album.initial_rating.at,new Date(Date.parse(album.initial_rating.at)+30*86400000).toISOString()); add('initial_now',album.initial_rating.at,nowIso); }
    if(album.current_score_at)add('current_now',album.current_score_at,nowIso);
  }
  for(const period of periods||[])if(period.period_type==='month')coverageWindows.push({key:`period_${period.id}_now`,start:period.utc_end,end:nowIso});
  const coverageRows=coverageWindows.length?await sb('rpc/hybrid_coverage_evidence',{method:'POST',body:JSON.stringify({p_user_id:username,p_epoch_id:epoch.id,p_windows:coverageWindows})}).catch(()=>[]):[];
  const coverageByKey=new Map((coverageRows||[]).map(x=>[x.metric_key,{milliseconds:Number(x.covered_milliseconds||0),ratio:Number(x.coverage_ratio||0),continuous:Boolean(x.continuous)}]));
  for(const album of albums)for(const window of coverageWindows.filter(x=>x.key.startsWith(`${album.album_id}:`))) { if(!album.coverage_metrics)album.coverage_metrics={}; album.coverage_metrics[window.key.slice(album.album_id.length+1)]=coverageByKey.get(window.key)||{milliseconds:0,ratio:0,continuous:false}; }
  const periodCoverage={}; for(const period of periods||[])periodCoverage[`period_${period.id}_now`]=coverageByKey.get(`period_${period.id}_now`)||{milliseconds:0,ratio:0,continuous:false};
  const byArtist=new Map(); for(const album of albums) { if(!byArtist.has(album.artist_id))byArtist.set(album.artist_id,[]); byArtist.get(album.artist_id).push(album); }
  const artists=[]; for(const [artistId,rated] of byArtist) { const group=groupById.get(rated[0].release_group_id), unique=[...new Map(rated.map(a=>[a.release_group_id,a])).values()]; artists.push({artist_id:artistId,artist:{id:artistId,mbid:group?.music_artists?.musicbrainz_artist_mbid||null,name:group?.music_artists?.display_name||''},rated_release_groups:unique.length,total_scrobbles:artistCountById.get(artistId)||0,release_groups:unique.map(a=>({id:a.release_group_id,title:a.release_group.title,score:a.current_score}))}); }
  const now=new Date(), localToday=localListeningParts(now,epoch.timezone).local_date, since=PeriodIntelligence.addDays(localToday,-89), trackingLocal=localListeningParts(epoch.lastfm_tracking_started_at,epoch.timezone).local_date;
  const [dailyArtists,dailyTotals,dailyReleaseCounts]=await Promise.all([
    sb(`listening_daily_artist_counts?user_id=eq.${encodeURIComponent(username)}&local_date=gte.${since}&select=local_date,artist_id,scrobble_count&limit=10000`),
    sb(`listening_daily_totals?user_id=eq.${encodeURIComponent(username)}&local_date=gte.${trackingLocal}&select=local_date,scrobble_count&limit=10000`),
    sb(`listening_daily_release_group_counts?user_id=eq.${encodeURIComponent(username)}&local_date=gte.${trackingLocal}&select=local_date,release_group_id,scrobble_count&limit=20000`)
  ]);
  const rollingCounts=new Map(); for(const row of dailyArtists||[])rollingCounts.set(row.artist_id,(rollingCounts.get(row.artist_id)||0)+Number(row.scrobble_count||0));
  const rankedListening=[...rollingCounts].sort((a,b)=>b[1]-a[1]), top=rankedListening[0];
  const ratedArtists=artists.map(a=>{ const scores=a.release_groups.map(x=>Number(x.score)).filter(Number.isFinite); return {...a,rating_mean:scores.length?scores.reduce((n,x)=>n+x,0)/scores.length:0,rating_count:scores.length}; }).sort((a,b)=>b.rating_mean-a.rating_mean);
  const best=ratedArtists[0],topRated=artists.find(a=>a.artist_id===top?.[0]);
  const rolling90=top?{version:1,window_start:PeriodIntelligence.zonedDateToUtc(since,epoch.timezone),window_end:new Date().toISOString(),top_artist_id:top[0],top_artist_plays:top[1],unique_top_artist:rankedListening.length===1||top[1]>rankedListening[1][1],top_artist:topRated?.artist||{id:top[0]},top_artist_album_count:topRated?.release_groups?.length||0,top_artist_rating_mean:topRated?.release_groups?.length?topRated.release_groups.reduce((n,x)=>n+Number(x.score||0),0)/topRated.release_groups.length:null,best_rated_artist_id:best?.artist_id||null,best_rated_album_count:best?.rating_count||0,best_rated_mean:best?.rating_mean||0,unique_best_rated_artist:ratedArtists.length===1||Number(best?.rating_mean)>Number(ratedArtists[1]?.rating_mean),artist:best?.artist||null}:null;
  return {albums,artists,coverage:[],period_coverage:periodCoverage,periods,rolling90,daily_totals:dailyTotals||[],daily_release_counts:dailyReleaseCounts||[],epoch_id:epoch.id,timezone:epoch.timezone,tracking_started_at:epoch.lastfm_tracking_started_at,now:nowIso};
}
async function evaluateHybridAchievements(username,source='hybrid_reevaluation') {
  if(!isAchievementBetaUser(username))return [];
  await ensureAchievementDefinitions();
  const evaluation=HybridRules.evaluate(await hybridEvaluationInput(username));
  await writeProgress(username,evaluation.progress);
  return persistAchievementCandidates(username,evaluation.candidates,source,new Date().toISOString());
}
async function discoveryGoneReturns(username,epoch) {
  const ghosted=await sb(`vault_achievement_unlocks?user_id=eq.${encodeURIComponent(username)}&achievement_key=eq.ghosted&select=id,unlocked_at,snapshot&order=unlocked_at.asc&limit=10`);
  const evidence=[];
  for(const unlock of ghosted||[]) {
    const releaseGroupId=unlock.snapshot?.release_group?.id, snapshotId=unlock.snapshot?.period_snapshot_id;
    if(!releaseGroupId||!snapshotId||String(unlock.snapshot?.epoch_id||epoch.id)!==String(epoch.id))continue;
    const period=(await sb(`listening_period_snapshots?id=eq.${snapshotId}&user_id=eq.${encodeURIComponent(username)}&epoch_id=eq.${epoch.id}&select=id,utc_end&limit=1`))?.[0];
    if(!period)continue;
    const plays=await sb(`listening_scrobbles?user_id=eq.${encodeURIComponent(username)}&epoch_id=eq.${epoch.id}&release_group_id=eq.${releaseGroupId}&played_at=gt.${encodeURIComponent(unlock.unlocked_at)}&select=id,played_at&order=played_at.asc&limit=100`);
    const first=plays?.[0]; if(!first)continue;
    const returnEnd=new Date(Date.parse(first.played_at)+14*86400000).toISOString(), qualifying=(plays||[]).filter(row=>Date.parse(row.played_at)<=Date.parse(returnEnd));
    const coverage=(await sb('rpc/hybrid_coverage_evidence',{method:'POST',body:JSON.stringify({p_user_id:username,p_epoch_id:epoch.id,p_windows:[{key:unlock.id,start:period.utc_end,end:first.played_at}]})}))?.[0];
    const group=(await sb(`music_release_groups?id=eq.${releaseGroupId}&select=id,display_title,musicbrainz_release_group_mbid,music_artists!inner(display_name)&limit=1`))?.[0];
    evidence.push({canonical:Boolean(group?.musicbrainz_release_group_mbid),same_epoch:true,epoch_id:epoch.id,release_group:{id:group?.id,mbid:group?.musicbrainz_release_group_mbid,title:group?.display_title||'',artist:group?.music_artists?.display_name||''},ghosted_unlock_id:unlock.id,ghosted_at:unlock.unlocked_at,absence_start:period.utc_end,return_started_at:first.played_at,return_window_end:returnEnd,absence_days:Math.floor((Date.parse(first.played_at)-Date.parse(period.utc_end))/86400000),return_scrobbles:qualifying.length,return_scrobble_ids:qualifying.slice(0,10).map(row=>row.id),coverage_ratio:Number(coverage?.coverage_ratio||0),coverage_continuous:Boolean(coverage?.continuous),evidence_version:1});
  }
  return evidence;
}
async function discoveryListeningInput(username) {
  const epoch=await getActiveLastfmEpoch(username); if(!epoch)return {periods:[],loveDive:[],goneReturns:[],finalizableWindows:[]};
  const [periods,loveRows]=await Promise.all([
    sb(`listening_period_snapshots?user_id=eq.${encodeURIComponent(username)}&epoch_id=eq.${epoch.id}&select=id,epoch_id,period_type,local_start,local_end,utc_start,utc_end,timezone,coverage_ratio,coverage_continuous,completeness,scrobble_total,rankings,snapshot_version&order=local_start.asc&limit=1000`),
    sb('rpc/discovery_love_dive_evidence',{method:'POST',body:JSON.stringify({p_user_id:username,p_epoch_id:epoch.id,p_limit:50})})
  ]);
  const artistIds=[...new Set((loveRows||[]).map(row=>row.artist_id).filter(Boolean))];
  const artists=artistIds.length?await sb(`music_artists?id=in.(${artistIds.join(',')})&select=id,display_name,musicbrainz_artist_mbid`):[];
  const artistById=new Map((artists||[]).map(row=>[row.id,row]));
  const coverageRows=loveRows?.length?await sb('rpc/hybrid_coverage_evidence',{method:'POST',body:JSON.stringify({p_user_id:username,p_epoch_id:epoch.id,p_windows:loveRows.map(row=>({key:row.artist_id,start:row.first_played_at,end:row.window_end}))})}):[];
  const earliestWindow=(loveRows||[]).map(row=>row.first_played_at).sort()[0], latestWindow=(loveRows||[]).map(row=>row.window_end).sort().at(-1);
  const knownGaps=earliestWindow?await sb(`listening_coverage_windows?user_id=eq.${encodeURIComponent(username)}&epoch_id=eq.${epoch.id}&status=in.(coverage_gap,disconnected)&coverage_end=gt.${encodeURIComponent(earliestWindow)}&coverage_start=lt.${encodeURIComponent(latestWindow)}&select=coverage_start,coverage_end,status`):[];
  const coverageById=new Map((coverageRows||[]).map(row=>[row.metric_key,row]));
  const loveDive=(loveRows||[]).map(row=>{ const coverage=coverageById.get(row.artist_id)||{},artist=artistById.get(row.artist_id)||{},terminalCoverageGap=(knownGaps||[]).some(gap=>Date.parse(gap.coverage_end)>Date.parse(row.first_played_at)&&Date.parse(gap.coverage_start)<Date.parse(row.window_end)); return {epoch_id:epoch.id,artist:{id:row.artist_id,mbid:artist.musicbrainz_artist_mbid||null,name:artist.display_name||''},first_played_at:row.first_played_at,window_start:row.first_played_at,window_end:row.window_end,window_complete:Date.parse(row.window_end)<=Date.now(),artist_scrobbles:Number(row.artist_scrobbles),total_scrobbles:Number(row.total_scrobbles),artist_rank:Number(row.artist_rank),identity_complete:Number(row.resolved_artist_scrobbles)===Number(row.total_scrobbles)&&Number(row.pending_identity)===0,coverage_ratio:Number(coverage.coverage_ratio||0),coverage_continuous:Boolean(coverage.continuous),terminal_coverage_gap:terminalCoverageGap,pending_identity:Number(row.pending_identity),evidence_version:Number(row.evidence_version||1)}; });
  const finalizableWindows=loveDive.filter(row=>row.pending_identity===0&&(row.coverage_continuous||row.terminal_coverage_gap)).map(row=>row.artist.id);
  return {periods:periods||[],loveDive,goneReturns:await discoveryGoneReturns(username,epoch),finalizableWindows,epoch};
}
async function evaluateDiscoveryListeningAchievements(username,source='discovery_temporal_evaluation') {
  if(!isAchievementBetaUser(username))return [];
  await ensureAchievementDefinitions();
  const input=await discoveryListeningInput(username),evaluation=DiscoveryRules.evaluateListening(input);
  const unlocks=await persistAchievementCandidates(username,evaluation.candidates,source,new Date().toISOString());
  for(const artistId of input.finalizableWindows||[]) await sb(`listening_discovery_artist_windows?user_id=eq.${encodeURIComponent(username)}&epoch_id=eq.${input.epoch.id}&artist_id=eq.${artistId}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({evaluated_at:new Date().toISOString(),updated_at:new Date().toISOString()})});
  return unlocks;
}
async function closeAchievementPeriodsForUser(username) {
  const epoch=await getActiveLastfmEpoch(username); if(!epoch)return {status:'not_configured',closed:0};
  let state=(await sb(`listening_period_closer_state?user_id=eq.${encodeURIComponent(username)}&epoch_id=eq.${epoch.id}&limit=1`))?.[0];
  if(!state) { const inserted=await sb('listening_period_closer_state?on_conflict=user_id,epoch_id',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=representation'},body:JSON.stringify({user_id:username,epoch_id:epoch.id,timezone:epoch.timezone,closing_started_at:new Date().toISOString()})}); state=inserted?.[0]||(await sb(`listening_period_closer_state?user_id=eq.${encodeURIComponent(username)}&epoch_id=eq.${epoch.id}&limit=1`))?.[0]; }
  if(state.timezone!==epoch.timezone) { const resetAt=new Date().toISOString(); await sb(`listening_period_closer_state?user_id=eq.${encodeURIComponent(username)}&epoch_id=eq.${epoch.id}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({timezone:epoch.timezone,closing_started_at:resetAt,updated_at:resetAt})}); state={...state,timezone:epoch.timezone,closing_started_at:resetAt}; }
  const closeGraceMs=24*60*60*1000;
  const specs=PeriodIntelligence.closedPeriodSpecs(state.closing_started_at,new Date(),state.timezone,epoch.lastfm_tracking_started_at), existing=await sb(`listening_period_snapshots?user_id=eq.${encodeURIComponent(username)}&epoch_id=eq.${epoch.id}&select=period_type,local_start&limit=1000`), keys=new Set((existing||[]).map(x=>`${x.period_type}|${x.local_start}`)), pending=specs.filter(x=>Date.parse(x.utc_end)<=Date.now()-closeGraceMs&&!keys.has(`${x.period_type}|${x.local_start}`));
  if(!pending.length) { await evaluateDiscoveryListeningAchievements(username,'period_close'); return {status:'current',closed:0}; }
  const earliest=pending.map(x=>x.local_start).sort()[0];
  const [dailyTotals,dailyReleases,dailyArtists,groups,artists,artistSegments]=await Promise.all([
    sb(`listening_daily_totals?user_id=eq.${encodeURIComponent(username)}&local_date=gte.${earliest}&select=local_date,scrobble_count&limit=10000`),
    sb(`listening_daily_release_group_counts?user_id=eq.${encodeURIComponent(username)}&local_date=gte.${earliest}&select=local_date,release_group_id,scrobble_count&limit=20000`),
    sb(`listening_daily_artist_counts?user_id=eq.${encodeURIComponent(username)}&local_date=gte.${earliest}&select=local_date,artist_id,scrobble_count&limit=20000`),
    sb('music_release_groups?select=id,display_title,musicbrainz_release_group_mbid,music_artists!inner(display_name)&limit=5000'),
    sb('music_artists?select=id,display_name,musicbrainz_artist_mbid&limit=5000'),
    sb('rpc/discovery_period_artist_segments',{method:'POST',body:JSON.stringify({p_user_id:username,p_epoch_id:epoch.id,p_windows:pending.filter(x=>x.period_type==='week').map(x=>({key:`${x.period_type}:${x.local_start}`,start:x.utc_start,end:x.utc_end}))})})
  ]);
  const releaseMeta=Object.fromEntries((groups||[]).map(x=>[x.id,{release_group:{id:x.id,mbid:x.musicbrainz_release_group_mbid,title:x.display_title,artist:x.music_artists?.display_name||''}}])),artistMeta=Object.fromEntries((artists||[]).map(x=>[x.id,{artist:{id:x.id,mbid:x.musicbrainz_artist_mbid,name:x.display_name}}]));
  const periodCoverageRows=await sb('rpc/hybrid_coverage_evidence',{method:'POST',body:JSON.stringify({p_user_id:username,p_epoch_id:epoch.id,p_windows:pending.map(x=>({key:`${x.period_type}:${x.local_start}`,start:x.utc_start,end:x.utc_end}))})}),periodCoverage=new Map((periodCoverageRows||[]).map(x=>[x.metric_key,{ratio:Number(x.coverage_ratio||0),continuous:Boolean(x.continuous)}])); let closed=0;
  for(const spec of pending) {
    const blockers=await sb(`listening_scrobbles?user_id=eq.${encodeURIComponent(username)}&epoch_id=eq.${epoch.id}&played_at=gte.${encodeURIComponent(spec.utc_start)}&played_at=lt.${encodeURIComponent(spec.utc_end)}&enrichment_status=in.(pending,retry)&select=id&limit=1`);
    if(blockers?.length)continue;
    const coverage=periodCoverage.get(`${spec.period_type}:${spec.local_start}`)||{ratio:0,continuous:false},snapshot=PeriodIntelligence.buildSnapshot(spec,{dailyTotals,dailyReleases,dailyArtists,artistSegments,releaseMeta,artistMeta,coverageRatio:coverage.ratio,coverageContinuous:coverage.continuous,epochId:epoch.id});
    const rows=await sb('listening_period_snapshots?on_conflict=user_id,epoch_id,period_type,local_start',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=representation'},body:JSON.stringify({user_id:username,...snapshot})}); if(rows?.length)closed+=1;
  }
  await sb(`listening_period_closer_state?user_id=eq.${encodeURIComponent(username)}&epoch_id=eq.${epoch.id}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({last_closed_at:new Date().toISOString(),updated_at:new Date().toISOString()})});
  if(closed)await evaluateHybridAchievements(username,'period_close');
  await evaluateDiscoveryListeningAchievements(username,'period_close');
  return {status:'success',closed};
}
async function closeAchievementPeriodsForAll() { const users=await sb('users?select=username&limit=50'),results=[]; for(const row of users||[])if(isAchievementBetaUser(row.username))results.push({user_id:row.username,...await closeAchievementPeriodsForUser(row.username)}); return results; }
async function syncLastfmEpoch(epoch, trigger='scheduler') {
  const lockToken=crypto.randomUUID();
  const acquired=await sb('rpc/lastfm_try_lock',{method:'POST',body:JSON.stringify({p_epoch_id:epoch.id,p_lock_token:lockToken,p_seconds:90})});
  if(!acquired) return {status:'locked'};
  const runId=await startListeningSyncRun(epoch), before=Date.parse(epoch.watermark_played_at), started=Date.parse(epoch.lastfm_tracking_started_at), cutoff=Math.max(started,before-LASTFM_OVERLAP_MS);
  let pages=0,observed=0,discarded=0,unresolved=0,ambiguous=0,lastfmStatus=200,reached=false,oldest=null,backlogCursor=null;
  try {
    const index=await canonicalListeningIndex(), collected=new Map();
    // When a prior job hit its page cap, page 1 still captures fresh plays and
    // the remaining budget walks older pages from the persisted continuation.
    let continuation=epoch.backlog_cursor_before ? Date.parse(epoch.backlog_cursor_before) : null;
    for(let page=1;page<=LASTFM_MAX_PAGES_PER_SYNC;page++) {
      const params={method:'user.getrecenttracks',user:epoch.lastfm_username,limit:String(LASTFM_PAGE_SIZE),page:String(continuation?1:page)};
      if(continuation) params.to=String(Math.floor(continuation/1000)-1);
      let data; try { data=await lastfmApi(params); } catch(error) { lastfmStatus=Number(error.status)||0; error.lastfmCode=error.code; throw error; }
      pages++; const tracks=Array.isArray(data?.recenttracks?.track)?data.recenttracks.track:(data?.recenttracks?.track?[data.recenttracks.track]:[]);
      const confirmed=tracks.filter(confirmedLastfmTrack); observed+=confirmed.length;
      for(const track of confirmed) {
        const played=Number(track.date.uts)*1000; if(!Number.isFinite(played)) continue;
        oldest=oldest===null?played:Math.min(oldest,played);
        if(played<started) { discarded++; continue; }
        const fingerprint=lastfmFingerprint(epoch.id,track); if(collected.has(fingerprint)) continue;
        const identity=resolveListeningIdentity(track,index); if(!identity.group) { unresolved++; if(String(identity.source).startsWith('ambiguous')) ambiguous++; }
        const local=localListeningParts(played,epoch.timezone);
        collected.set(fingerprint,{artist_id:identity.artist?.id||null,release_group_id:identity.group?.id||null,source_artist:lastfmTrackText(track,'artist'),source_album:lastfmTrackText(track,'album')||null,source_track:String(track?.name||'').trim(),source_artist_mbid:safeMbId(track?.artist?.mbid),source_album_mbid:safeMbId(track?.album?.mbid),source_track_mbid:safeMbId(track?.mbid),played_at:new Date(played).toISOString(),local_date:local.local_date,local_hour:local.local_hour,source_fingerprint:fingerprint,match_confidence:identity.confidence,match_source:identity.source});
      }
      if(oldest!==null&&oldest<=cutoff) { reached=true; break; }
      const totalPages=Number(data?.recenttracks?.['@attr']?.totalPages||1);
      if(!tracks.length || (!continuation && page>=totalPages)) { reached=true; break; }
      continuation=oldest;
      if(page===LASTFM_MAX_PAGES_PER_SYNC) backlogCursor=oldest;
    }
    const latestObserved=Math.max(before,...[...collected.values()].map(x=>Date.parse(x.played_at)).filter(Number.isFinite));
    const now=Date.now(), coverageUntil=reached&&now-LASTFM_OVERLAP_MS> Date.parse(epoch.coverage_cursor_at) ? new Date(now-LASTFM_OVERLAP_MS).toISOString() : null;
    const rows=await sb('rpc/lastfm_apply_sync_batch',{method:'POST',body:JSON.stringify({p_epoch_id:epoch.id,p_user_id:epoch.user_id,p_items:[...collected.values()],p_watermark:reached?new Date(latestObserved).toISOString():epoch.watermark_played_at,p_coverage_until:coverageUntil,p_backlog_cursor_before:reached?null:(backlogCursor?new Date(backlogCursor).toISOString():epoch.backlog_cursor_before||null)})});
    await sb('rpc/listening_capture_source_track_mbids',{method:'POST',body:JSON.stringify({p_epoch_id:epoch.id,p_items:[...collected.values()]})});
    const inserted=Number(rows?.[0]?.inserted||0), duplicates=Math.max(0,collected.size-inserted);
    const unlocks=await evaluateListeningAchievements(epoch.user_id,'lastfm_sync');
    await syncRunPatch(runId,{completed_at:new Date().toISOString(),status:reached?'success':'backlog',pages,observed,inserted,duplicates,discarded_pre_tracking:discarded,unresolved,ambiguous,watermark_after:reached?new Date(latestObserved).toISOString():epoch.watermark_played_at,coverage_until:coverageUntil,lastfm_status:lastfmStatus,metadata:{trigger,backlog_pending:!reached}});
    console.log(JSON.stringify({event:'lastfm_sync',epoch:epoch.id.slice(0,8),pages,observed,inserted,duplicates,discarded_pre_tracking:discarded,unresolved,ambiguous,watermark_before:epoch.watermark_played_at,watermark_after:reached?new Date(latestObserved).toISOString():epoch.watermark_played_at,coverage_until:coverageUntil,status:reached?'success':'backlog'}));
    return {status:reached?'success':'backlog',pages,observed,inserted,duplicates,unlocks:unlocks.length};
  } catch(error) {
    await sb(`lastfm_tracking_epochs?id=eq.${epoch.id}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({last_sync_at:new Date().toISOString(),last_error_at:new Date().toISOString(),last_error_code:String(error.lastfmCode||error.status||'sync_error'),consecutive_failures:Number(epoch.consecutive_failures||0)+1,updated_at:new Date().toISOString()})}).catch(()=>{});
    await syncRunPatch(runId,{completed_at:new Date().toISOString(),status:'failed',pages,observed,discarded_pre_tracking:discarded,unresolved,ambiguous,lastfm_status:lastfmStatus,error_code:String(error.message||error).slice(0,160)}).catch(()=>{});
    console.warn(JSON.stringify({event:'lastfm_sync_failed',epoch:epoch.id.slice(0,8),pages,lastfm_status:lastfmStatus,error:String(error.message||error).slice(0,140)}));
    throw error;
  } finally { await sb('rpc/lastfm_release_lock',{method:'POST',body:JSON.stringify({p_epoch_id:epoch.id,p_lock_token:lockToken})}).catch(()=>{}); }
}
async function syncConfiguredLastfmUser(username, trigger='scheduler', profileOverride=undefined) {
  if(!isAchievementBetaUser(username)) return {status:'beta_disabled'};
  const profile=profileOverride===undefined ? await getVaultProfile(username) : profileOverride;
  const epoch=await activateLastfmTracking(username,profile||{});
  if(!epoch) return {status:'not_configured'};
  return syncLastfmEpoch(epoch,trigger);
}
async function syncAllConfiguredLastfmUsers(trigger='scheduler') {
  const users=await sb('users?select=username,timezone,vault_profile&limit=50'); const results=[];
  for(const row of users||[]) if(isAchievementBetaUser(row.username)) {
    const profile={...(row.vault_profile||{}),timezone:row.timezone||row.vault_profile?.timezone||'UTC'};
    try { results.push({user_id:row.username,...await syncConfiguredLastfmUser(row.username,trigger,profile)}); } catch(error) { results.push({user_id:row.username,status:'failed'}); }
  }
  return results;
}
async function listeningTrackingReadModel(username) {
  const [active,coverage,records]=await Promise.all([
    getActiveLastfmEpoch(username),
    sb(`listening_coverage_windows?user_id=eq.${encodeURIComponent(username)}&select=coverage_start,coverage_end,status&order=coverage_end.desc&limit=12`),
    sb(`vault_personal_records?user_id=eq.${encodeURIComponent(username)}&record_key=in.(most_played_artist,most_played_album,dominant_listening_hour)`)
  ]);
  // PostgREST range count is exposed in headers but the tiny helper intentionally
  // avoids leaking headers; the compact exact count endpoint below is safe here.
  const rows=await sb(`listening_scrobbles?user_id=eq.${encodeURIComponent(username)}&select=id&limit=5001`);
  return {configured:Boolean(active),trackingStartedAt:active?.lastfm_tracking_started_at||null,epoch:active?{id:active.id,number:active.epoch_number,username:active.lastfm_username,watermark:active.watermark_played_at,lastSuccessAt:active.last_success_at,status:active.status,timezone:active.timezone}:null,trackedScrobbles:(rows||[]).length,coverage,records};
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
  const unlocks=await persistAchievementCandidates(username,evaluation.candidates,event.source,event.occurred_at);
  const discoveryEvaluation=DiscoveryRules.evaluateVault({event,eligibleEvents});
  const discoveryUnlocks=await persistAchievementCandidates(username,discoveryEvaluation.candidates,event.source,event.occurred_at);
  const hybridUnlocks=await evaluateHybridAchievements(username,event.type==='identity_resolved'?'identity_enrichment':event.source);
  await refreshRatingRecords(username, eligibleEvents);
  const allUnlocks=[...unlocks,...discoveryUnlocks,...hybridUnlocks];
  await sb(`vault_achievement_events?event_id=eq.${eventId}`,{method:'PATCH',headers:{Prefer:'return=minimal'},body:JSON.stringify({processed_at:new Date().toISOString(),unlock_ids:allUnlocks.map(u=>u.id)})});
  if(allUnlocks.length){await syncCosmeticEntitlements(username);await refreshEmblemState(username);}
  return allUnlocks;
}
async function processAchievementEvents(username, eventIds) {
  const all=[]; for (const id of eventIds || []) all.push(...await processAchievementEvent(username,id)); return all;
}
async function achievementReadModel(username) {
  await ensureAchievementDefinitions();
  await Promise.all([syncCosmeticEntitlements(username),refreshAchievementPrevalence(username)]);
  const [defs,progress,artistProgress,unlocks,showcase,records,inbox,state,emblem,entitlements,cosmeticState,prevalence] = await Promise.all([
    sb('vault_achievement_definitions?enabled=eq.true&order=key.asc'), sb(`vault_achievement_progress?user_id=eq.${encodeURIComponent(username)}`),
    sb(`vault_artist_achievement_progress?user_id=eq.${encodeURIComponent(username)}&order=current_value.desc`),
    sb(`vault_achievement_unlocks?user_id=eq.${encodeURIComponent(username)}&select=id,achievement_key,level,unlocked_at,source,public_visible,snapshot&order=unlocked_at.desc`),
    sb(`vault_achievement_showcase?user_id=eq.${encodeURIComponent(username)}&order=position.asc`), sb(`vault_personal_records?user_id=eq.${encodeURIComponent(username)}`),
    sb(`vault_achievement_inbox?user_id=eq.${encodeURIComponent(username)}&delivered_at=is.null&order=created_at.asc`), sb(`vault_achievement_state?user_id=eq.${encodeURIComponent(username)}&select=achievement_tracking_started_at&limit=1`),
    refreshEmblemState(username),sb(`vault_cosmetic_entitlements?user_id=eq.${encodeURIComponent(username)}&select=cosmetic_key,source_achievement_key,granted_at,metadata&order=granted_at.asc`),sb(`vault_cosmetic_state?user_id=eq.${encodeURIComponent(username)}&select=equipped_key&limit=1`),sb('vault_achievement_prevalence?display_enabled=eq.true&eligible_population=gte.30&select=achievement_key,eligible_population,unlocked_population,percentage,calculated_at')
  ]);
  const safe=achievementTrustBoundary({definitions:defs,progress,artistProgress,unlocks,showcase,inbox});
  const unlockedKeys=new Set(safe.unlocks.map(u=>u.achievement_key));
  const visibleKeys=new Set(safe.definitions.map(row=>row.key));
  return { ...safe, records, emblem, cosmetics:{entitlements,available:COSMETIC_REWARDS.map(({key,title})=>({key,title})).filter(row=>entitlements.some(item=>item.cosmetic_key===row.key)),equipped:cosmeticState?.[0]?.equipped_key||null},prevalence:(prevalence||[]).filter(row=>visibleKeys.has(row.achievement_key)),trackingStartedAt:state?.[0]?.achievement_tracking_started_at || null, unlockedFamilies:unlockedKeys.size };
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
  const current=await getVaultProfile(username);
  const timezone=normalizeIanaTimezone(profile?.timezone || current?.timezone || 'UTC');
  await sb('rpc/set_user_listening_timezone',{method:'POST',body:JSON.stringify({p_user_id:username,p_timezone:timezone})});
  const storedProfile=profile==null ? {timezone} : {...profile,timezone};
  const res = await fetch(`${SUPABASE_URL}/rest/v1/users?username=eq.${encodeURIComponent(username)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ vault_profile: storedProfile })
  });
  if (!res.ok) { const err = await res.text(); throw new Error(err); }
}

async function getVaultProfile(username) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/users?username=eq.${encodeURIComponent(username)}&select=vault_profile,timezone&limit=1`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  const data = await res.json();
  const row=data[0];
  if(!row) return null;
  return {...(row.vault_profile||{}),timezone:row.timezone||row.vault_profile?.timezone||null};
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

// The posting destination is private server-side configuration. The browser may
// edit it only through an authenticated session; /post itself never accepts a
// destination or user identity from form data.
app.post('/rater/discord-settings', express.json(), async (req, res) => {
  try {
    const username = await verifyTokenFromStore(req.body?.token);
    if (!username) return res.status(401).json({ error: 'Sesión inválida o expirada' });
    const threadId = await saveRaterDiscordThreadId(username, req.body?.thread_id);
    res.json({ ok: true, thread_id: threadId });
  } catch (err) {
    const isInvalidThread = /Thread ID inválido/i.test(String(err?.message || ''));
    if (isInvalidThread) return res.status(400).json({ error: 'Ingresá un Thread ID válido de Discord.' });
    console.error('[rater discord settings]', err.message);
    res.status(500).json({ error: 'No se pudo guardar la configuración de Discord.' });
  }
});

app.post('/rater/discord-settings/get', express.json(), async (req, res) => {
  try {
    const username = await verifyTokenFromStore(req.body?.token);
    if (!username) return res.status(401).json({ error: 'Sesión inválida o expirada' });
    res.json({ ok: true, thread_id: await getRaterDiscordThreadId(username) });
  } catch (err) {
    console.error('[rater discord settings get]', err.message);
    res.status(500).json({ error: 'No se pudo cargar la configuración de Discord.' });
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
        event.payload.review_char_count = review.trim().length;
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
app.post('/achievements/emblem/acknowledge', express.json(), async (req,res) => {
  try { const username=await verifyToken(req.body?.token); if(!username)return res.status(401).json({error:'Sesión inválida o expirada'}); if(!isAchievementBetaUser(username))return res.status(403).json({error:'Achievement Vault está en beta privada'}); await acknowledgePendingEmblem(username); res.json({ok:true,...await achievementReadModel(username)}); }
  catch(error){console.error('[emblem acknowledge]',error.message);res.status(500).json({error:'No se pudo confirmar el Vault Emblem'});}
});
app.post('/achievements/cosmetics/equip', express.json(), async (req,res) => {
  try {
    const username=await verifyToken(req.body?.token); if(!username)return res.status(401).json({error:'Sesión inválida o expirada'}); if(!isAchievementBetaUser(username))return res.status(403).json({error:'Achievement Vault está en beta privada'});
    const key=req.body?.key===null?null:String(req.body?.key||'');
    if(key){const owned=await sb(`vault_cosmetic_entitlements?user_id=eq.${encodeURIComponent(username)}&cosmetic_key=eq.${encodeURIComponent(key)}&select=cosmetic_key&limit=1`);if(!owned?.length)return res.status(400).json({error:'Cosmetic no disponible'});}
    await sb('vault_cosmetic_state?on_conflict=user_id',{method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({user_id:username,equipped_key:key||null,updated_at:new Date().toISOString()})});
    res.json({ok:true,equipped:key||null});
  } catch(error){console.error('[cosmetic equip]',error.message);res.status(500).json({error:'No se pudo equipar el cosmetic'});}
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
// Phase 2 read/refresh endpoints reuse the existing Vault session and profile
// username. They never accept a Last.fm username, timestamps or fingerprints
// from the browser.
app.post('/listening/me', express.json(), async (req,res) => {
  try {
    const username=await verifyToken(req.body?.token); if(!username) return res.status(401).json({error:'Sesión inválida o expirada'});
    if(!isAchievementBetaUser(username)) return res.json({ok:true,beta:false});
    res.json({ok:true,beta:true,...await listeningTrackingReadModel(username)});
  } catch(error) { console.error('[listening read]',error.message); res.status(500).json({error:'No se pudo leer el tracking de Last.fm'}); }
});
app.post('/listening/sync', express.json(), async (req,res) => {
  try {
    const username=await verifyToken(req.body?.token); if(!username) return res.status(401).json({error:'Sesión inválida o expirada'});
    if(!isAchievementBetaUser(username)) return res.json({ok:true,beta:false});
    const result=await syncConfiguredLastfmUser(username,'manual_refresh');
    res.json({ok:true,...result,...await listeningTrackingReadModel(username)});
  } catch(error) { console.error('[listening manual sync]',error.message); res.status(502).json({error:'No se pudo sincronizar Last.fm ahora'}); }
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

// Invoked only by Supabase pg_cron through pg_net. The secret lives in the
// private scheduler table; this route derives no user id from the request.
function schedulerTokenMatches(provided, expected) {
  const a=Buffer.from(String(provided||'')), b=Buffer.from(String(expected||''));
  return a.length===b.length && a.length>0 && crypto.timingSafeEqual(a,b);
}
const schedulerPipelines=createSchedulerPipelines({syncAll:syncAllConfiguredLastfmUsers,enrichBatch:runListeningEnrichmentBatch});
app.post('/internal/lastfm/sync', express.json({limit:'16kb'}), async (req,res) => {
  try {
    const config=(await sb('listening_scheduler_config?singleton=eq.true&select=scheduler_token&limit=1'))?.[0];
    if(!config || !schedulerTokenMatches(req.get('x-album-vault-scheduler'),config.scheduler_token)) return res.status(403).json({error:'Forbidden'});
    const {results,duration_ms}=await schedulerPipelines.sync('supabase_cron');
    console.log(JSON.stringify({event:'lastfm_sync_endpoint',duration_ms,status:'success'}));
    res.json({ok:true,duration_ms,results:results.map(x=>({status:x.status,pages:x.pages||0,inserted:x.inserted||0}))});
  } catch(error) { console.error('[lastfm scheduler]',error.message); res.status(500).json({error:'Listening sync failed'}); }
});
app.post('/internal/listening/enrich', express.json({limit:'16kb'}), async (req,res) => {
  try {
    const config=(await sb('listening_scheduler_config?singleton=eq.true&select=scheduler_token&limit=1'))?.[0];
    if(!config || !schedulerTokenMatches(req.get('x-album-vault-scheduler'),config.scheduler_token)) return res.status(403).json({error:'Forbidden'});
    const result=await schedulerPipelines.enrich(Math.max(1,Math.min(10,Number(req.body?.limit)||1)));
    console.log(JSON.stringify({event:'listening_enrichment_endpoint',duration_ms:result.duration_ms,processed:result.processed,status:'success'}));
    res.json({ok:true,...result});
  } catch(error) { console.error('[listening enrichment endpoint]',error.message); res.status(500).json({error:'Listening enrichment failed'}); }
});
app.post('/internal/achievements/period-close', express.json({limit:'16kb'}), async (req,res) => {
  try {
    const config=(await sb('listening_scheduler_config?singleton=eq.true&select=scheduler_token&limit=1'))?.[0];
    if(!config || !schedulerTokenMatches(req.get('x-album-vault-scheduler'),config.scheduler_token)) return res.status(403).json({error:'Forbidden'});
    const started=Date.now(),results=await closeAchievementPeriodsForAll(),duration_ms=Date.now()-started;
    console.log(JSON.stringify({event:'achievement_period_close_endpoint',duration_ms,closed:results.reduce((n,x)=>n+Number(x.closed||0),0),status:'success'}));
    res.json({ok:true,duration_ms,results});
  } catch(error) { console.error('[achievement period close]',error.message); res.status(500).json({error:'Achievement period close failed'}); }
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
  // Startup is merely a fast first attempt. Supabase Cron is the durable
  // scheduler and continues waking this endpoint even while Render sleeps.
  setTimeout(() => { syncAllConfiguredLastfmUsers('startup').catch(error => console.error('[lastfm startup]',error.message)); }, 15000);
});

      
