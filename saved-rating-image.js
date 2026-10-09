'use strict';

const fs = require('fs');
const path = require('path');
const css = fs.readFileSync(path.join(__dirname, 'saved-rating-export.css'), 'utf8');
const FONT_URL = 'https://fonts.googleapis.com/css2?family=Syne:wght@400;600;800&family=DM+Mono:wght@300;400;500&family=Inter:wght@300;400;500;600;700&family=Caveat:wght@400;500&display=swap';
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const html = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const score = value => value !== null && value !== undefined && String(value).trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const placeholder = '<div class="out-hero-cover-placeholder"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></svg></div>';

// Rendering saved text must not turn the bot into an arbitrary network client.
// These are the cover/font CDNs supported by the Rater; unknown covers simply
// use a placeholder. No scripts, private hosts, credentials or inline SVG URLs.
function allowedAsset(url) {
  if (url === 'about:blank') return true;
  if (/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(url)) return url.length < 6 * 1024 * 1024;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) return false;
    const host = parsed.hostname.toLowerCase();
    return ['fonts.googleapis.com', 'fonts.gstatic.com', 'e-cdns-images.dzcdn.net', 'cdn-images.dzcdn.net', 'coverartarchive.org', 'archive.org', 'cdn.discordapp.com', 'media.discordapp.net', 'i.scdn.co'].includes(host)
      || /^(?:is\d+-ssl\.mzstatic\.com|lastfm(?:-img)?\.freetls\.fastly\.net|[a-z0-9-]+\.archive\.org|[a-z0-9-]+\.media-amazon\.com)$/.test(host);
  } catch (_) { return false; }
}

function coverAsset(value) {
  const url = String(value || '');
  return allowedAsset(url) && url !== 'about:blank' && !url.includes('fonts.googleapis.com') && !url.includes('fonts.gstatic.com') ? url : '';
}

function rankClass(rank) {
  const value = String(rank || '').toUpperCase();
  if (value.startsWith('SS')) return 'rank-ss';
  if (value.startsWith('S')) return 'rank-s';
  if (value.startsWith('A')) return 'rank-a';
  if (value.startsWith('B')) return 'rank-b';
  if (value.startsWith('C') || value.startsWith('D') || value.startsWith('F')) return 'rank-c';
  return 'rank-none';
}

function buildSavedRatingHtml(rating) {
  let tracks = rating.tracks;
  if (typeof tracks === 'string') { try { tracks = JSON.parse(tracks); } catch (_) { tracks = []; } }
  if (!Array.isArray(tracks)) tracks = [];
  if (tracks.length > 100) throw new Error('Too many tracks to export');
  const entries = tracks.map((track, index) => ({ name: String(track?.name || `Track ${index + 1}`).slice(0, 500), score: score(track?.score) }));
  const rated = entries.filter(track => track.score !== null);
  const best = rated.length ? rated.reduce((a, b) => b.score > a.score ? b : a) : null;
  const title = String(rating.album_title || 'Álbum').slice(0, 500);
  const cover = coverAsset(rating.cover_url);
  // JSON quoting produces a CSS string; HTML escaping protects the attribute.
  const background = cover ? html(`background-image:url(${JSON.stringify(cover)})`) : '';
  const density = entries.length <= 7 ? 'spacious' : entries.length <= 14 ? 'balanced' : 'compact';
  const titleClass = title.length > 34 ? ' very-long' : title.length > 23 ? ' long' : '';
  const final = score(rating.final_score), coverScore = score(rating.cover_score);
  const rank = String(rating.final_rank || '—').slice(0, 20);
  const trackHtml = entries.map((track, index) => `<div class="out-track${track === best ? ' best' : ''}${track.score !== null && track.score >= 11 ? ' score-11' : ''}">
    <span class="out-track-num">${String(index + 1).padStart(2, '0')}</span><span class="out-track-name">${html(track.name)}</span>
    <span class="out-track-score${track.score !== null && track.score >= 9 ? ' tone-high' : track.score !== null && track.score >= 8.5 ? ' tone-good' : ''}">${track.score === null ? '—' : track.score.toFixed(1)}</span></div>`).join('');
  const card = `<div class="out-card density-${density}${cover ? '' : ' no-cover'}">
    ${cover ? `<div class="out-card-bg" style="${background}"></div>` : ''}
    <div class="out-export-content"><section class="out-hero">
      <div class="out-hero-cover">${cover ? `<img src="${html(cover)}" alt="Portada">` : placeholder}</div>
      <div class="out-hero-info"><div class="out-hero-kicker"><span class="out-hero-kicker-year">${html(String(rating.year || '—').slice(0, 30))}</span></div>
        <h2 class="out-album-name${titleClass}">${html(title)}</h2><div class="out-album-artist">${html(String(rating.artist || '').slice(0, 300))}</div>
        ${rating.genre ? `<div class="out-album-badges"><span class="out-album-badge genre">${html(String(rating.genre).slice(0, 300))}</span></div>` : ''}
        ${coverScore === null ? '' : `<div class="out-album-cover-score"><span class="out-cover-score-star">★</span><span class="out-cover-score-copy"><span class="out-album-cover-score-val">${coverScore.toFixed(1)}</span><span class="out-album-cover-score-label">Portada</span></span></div>`}
      </div></section>
      ${entries.length ? `<section class="out-track-panel"><div class="out-track-panel-layout"><div class="out-track-list${entries.length > 6 ? ' two-columns' : ''}">${trackHtml}</div></div></section>` : ''}
      <footer class="out-footer">${cover ? `<div class="out-footer-cover" style="${background}"></div>` : ''}
        <div class="out-footer-copy">${best ? `<div class="out-best-track"><span class="out-best-star">★</span><span class="out-best-label">Best Track</span><span class="out-best-name">${html(best.name)}</span></div>` : ''}</div>
        <div class="out-final"><div class="out-final-right">${final === null ? '' : `<span class="out-final-avg ${rankClass(rank)}">${final.toFixed(2)}</span>`}<span class="out-final-rank ${rankClass(rank)}">${html(rank)}</span></div></div>
      </footer></div></div>`;
  // Scores/rank come directly from the saved record. No averages, rescore
  // deltas or short-track penalties are reconstructed from the track list.
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'none'; connect-src 'none'"><link rel="stylesheet" href="${html(FONT_URL)}"><style>${css}</style></head><body>${card}</body></html>`;
}

async function renderSavedRating(rating, { launchBrowser, compress, renderTimeout = 45000 }) {
  const document = buildSavedRatingHtml(rating);
  let browser, timer, expired = false, buffer;
  try {
    browser = await launchBrowser();
    timer = setTimeout(() => { expired = true; browser.close().catch(() => {}); }, renderTimeout);
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 2600, deviceScaleFactor: 1.5 });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const allowed = ['document', 'image', 'stylesheet', 'font'].includes(request.resourceType()) && allowedAsset(request.url());
      (allowed ? request.continue() : request.abort()).catch(() => {});
    });
    await page.setContent(document, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.evaluate(async () => {
      await Promise.all([
        Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 4000))]),
        ...Array.from(document.images).map(image => Promise.race([
          image.complete ? Promise.resolve() : new Promise(resolve => { image.onload = resolve; image.onerror = resolve; }),
          new Promise(resolve => setTimeout(resolve, 8000))
        ]))
      ]);
      for (const image of document.images) {
        if (!image.naturalWidth) {
          const fallback = document.createElement('div');
          fallback.className = 'out-hero-cover-placeholder'; fallback.textContent = '—';
          image.replaceWith(fallback);
        }
      }
      // Keep long Best Track names inside the footer, preserving the hero's
      // typography and avoiding a wider-than-canvas screenshot.
      const best = document.querySelector('.out-best-name');
      if (best) best.style.fontSize = best.textContent.length > 32 ? '32px' : '48px';
    });
    const card = await page.$('.out-card');
    const bounds = card && await card.boundingBox();
    if (!bounds || bounds.height > 4200 || expired) throw new Error('Saved rating exceeds render bounds');
    buffer = Buffer.from(await card.screenshot({ type: 'png', omitBackground: false }));
  } finally {
    clearTimeout(timer);
    if (browser) await browser.close().catch(() => {});
  }
  // Chromium is already closed before libvips compression starts.
  if (buffer.length > MAX_ATTACHMENT_BYTES && compress) buffer = await compress(buffer);
  if (buffer.length > MAX_ATTACHMENT_BYTES) throw new Error('Saved rating exceeds attachment limit');
  return buffer;
}

module.exports = { buildSavedRatingHtml, renderSavedRating, allowedAsset, MAX_ATTACHMENT_BYTES };
