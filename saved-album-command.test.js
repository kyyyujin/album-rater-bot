'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { albumCommandDefinition, createSavedRatingRepository, createSavedAlbumCommand, ensureAlbumCommand, matches, suggestions } = require('./saved-album-command');
const { buildSavedRatingHtml, renderSavedRating, allowedAsset } = require('./saved-rating-image');
const ID = '12345678-1234-1234-1234-123456789abc';
const OTHER_ID = '87654321-1234-1234-1234-123456789abc';
const stored = { id: ID, album_title: 'Álbum Guardado', artist: 'Red Velvet', final_score: '8.65', final_rank: 'B+', cover_score: 0, tracks: [{ name: 'Primera', score: '8.90' }, { name: 'Segunda', score: '11.0' }] };
const quiet = { warn() {} };

function interaction(input = 'rating:' + ID, { autocomplete = false, artist = '', user = '123456789', focus = 'nombre' } = {}) {
  const calls = [];
  return { commandName: 'album', user: { id: user, username: 'UNRELATED_NEW_USERNAME' }, calls,
    isAutocomplete: () => autocomplete, isChatInputCommand: () => !autocomplete,
    options: { getString: name => name === 'nombre' ? input : artist, getFocused: () => ({ name: focus, value: input }) },
    deferReply: async () => calls.push(['defer']), editReply: async value => calls.push(['reply', value]), respond: async value => calls.push(['choices', value]) };
}

test('repository resolves immutable Discord ID and owner-scopes the chosen rating', async () => {
  const paths = [];
  const repository = createSavedRatingRepository({ read: async path => {
    paths.push(path);
    return path.startsWith('users?') ? [{ username: 'Old "Name", &' }] : [stored];
  } });
  await repository.get('123456789', ID);
  assert.match(paths[0], /discord_id=eq\.123456789/);
  const url = new URL('https://example.com/' + paths[1]);
  assert.equal(url.searchParams.get('user_id'), 'eq."Old \\"Name\\", &"');
  assert.equal(url.searchParams.get('id'), 'eq.' + ID);
  assert.equal(await repository.get('123456789', 'not-a-uuid'), null);
  assert.equal(paths.length, 2);
});

test('unlinked and ambiguous identity return no catalog or data', async () => {
  for (const users of [[], [{ username: 'A' }, { username: 'B' }]]) {
    let calls = 0;
    const repository = createSavedRatingRepository({ read: async () => { calls++; return users; } });
    assert.equal(await repository.list('123456789'), null);
    assert.equal(calls, 1);
  }
});

test('catalog paginates instead of silently truncating at the REST default', async () => {
  const paths = [];
  const repository = createSavedRatingRepository({ read: async path => {
    paths.push(path);
    if (path.startsWith('users?')) return [{ username: 'Kyujin' }];
    return path.endsWith('offset=0') ? Array.from({ length: 500 }, () => stored) : [stored];
  } });
  assert.equal((await repository.list('123456789')).length, 501);
  assert.match(paths.at(-1), /offset=500/);
});

test('lookup normalizes accents, prefers exact title and respects artist', () => {
  const list = [stored, { ...stored, id: OTHER_ID, album_title: 'Album Guardado Deluxe' }, { ...stored, id: OTHER_ID, artist: 'No Cure' }];
  assert.equal(matches(list, 'ALBUM guardado').length, 2);
  assert.equal(matches(list, 'album guardado', 'red')[0].id, ID);
  assert.equal(matches(list, '').length, 0);
  const choices = suggestions(Array.from({ length: 30 }, () => ({ ...stored, album_title: 'Á'.repeat(150) })), '');
  assert.equal(choices.length, 25);
  assert.equal(choices[0].name.length, 100);
  assert.equal(choices[0].value, 'rating:' + ID);
});

test('slash defers first, exports saved data and suppresses mentions', async () => {
  const event = interaction('album guardado');
  const handle = createSavedAlbumCommand({ logger: quiet, repository: {
    list: async id => { assert.equal(id, event.user.id); assert.equal(event.calls[0][0], 'defer'); return [stored]; },
    get: async (id, ratingId) => { assert.equal(ratingId, ID); return stored; }
  }, render: async rating => { assert.equal(rating.final_score, '8.65'); return Buffer.from('PNG'); } });
  assert.equal(await handle(event), true);
  const output = event.calls.at(-1)[1];
  assert.equal(output.files[0].name, 'album-guardado.png');
  assert.deepEqual(output.allowedMentions, { parse: [] });
});

test('forged autocomplete ID does not render someone else’s rating', async () => {
  let renders = 0;
  const handle = createSavedAlbumCommand({ logger: quiet, repository: { get: async (id, ratingId) => { assert.equal(id, '123456789'); assert.equal(ratingId, OTHER_ID); return null; } }, render: async () => renders++ });
  const event = interaction('rating:' + OTHER_ID);
  await handle(event);
  assert.equal(renders, 0);
  assert.match(event.calls.at(-1)[1].content, /no está disponible/);
});

test('ambiguous and missing names do not silently choose an album', async () => {
  for (const [rows, message] of [[null, /Vincula/], [[], /No encontré/], [[stored, { ...stored, id: OTHER_ID }], /varios ratings/]]) {
    const event = interaction('album guardado');
    const handle = createSavedAlbumCommand({ logger: quiet, repository: { list: async () => rows }, render: async () => assert.fail('Must not render') });
    await handle(event);
    assert.match(event.calls.at(-1)[1].content, message);
  }
});

test('autocomplete caches per Discord account and times out safely', async () => {
  let calls = 0;
  const handle = createSavedAlbumCommand({ logger: quiet, autocompleteTimeout: 5, repository: { list: async id => { calls++; return id === '123456789' ? [stored] : []; } } });
  for (const user of ['123456789', '123456789', '987654321']) await handle(interaction('Red Velvet', { autocomplete: true, user }));
  assert.equal(calls, 2);
  const slow = createSavedAlbumCommand({ logger: quiet, autocompleteTimeout: 5, repository: { list: () => new Promise(() => {}) } });
  const event = interaction('', { autocomplete: true });
  await slow(event);
  assert.deepEqual(event.calls, [['choices', []]]);
});

test('busy renderer permits immediate retry, successful render adds cooldown', async () => {
  let attempts = 0;
  const handle = createSavedAlbumCommand({ logger: quiet, now: () => 100, repository: { get: async () => stored }, render: async () => {
    if (++attempts === 1) { const error = new Error('busy'); error.code = 'RENDER_BUSY'; throw error; }
    return Buffer.from('PNG');
  } });
  const events = [interaction(), interaction(), interaction()];
  for (const event of events) await handle(event);
  assert.match(events[0].calls.at(-1)[1].content, /ocupado/);
  assert.ok(events[1].calls.at(-1)[1].files);
  assert.match(events[2].calls.at(-1)[1].content, /15 segundos/);
  assert.equal(attempts, 2);
});

test('registration is additive and idempotent with Discord.js option casing', async () => {
  const commands = [{ name: 'ping', type: 1 }, { name: 'historial', type: 1 }];
  const writes = [];
  const manager = { fetch: async () => commands, create: async value => { writes.push(value); commands.push({ ...value, type: 1 }); }, edit: async () => assert.fail('Existing commands must be preserved') };
  assert.equal(await ensureAlbumCommand(manager), 'registered');
  assert.equal(await ensureAlbumCommand(manager), 'already registered');
  commands[2].options = albumCommandDefinition.options.map(({ max_length, ...option }) => ({ ...option, maxLength: max_length }));
  assert.equal(await ensureAlbumCommand(manager), 'already registered');
  assert.equal(writes.length, 1);
  assert.equal(commands.length, 3);
});

test('HTML preserves stored score/rank, zero cover score and unscored tracks; escapes markup', () => {
  const document = buildSavedRatingHtml({ ...stored, album_title: '<script>alert(1)</script>', artist: '" onclick="evil', tracks: [...stored.tracks, { name: '<img src=x onerror=evil>', score: null }] });
  assert.match(document, /out-final-avg rank-b">8\.65/);
  assert.match(document, /out-final-rank rank-b">B\+/);
  assert.match(document, /out-album-cover-score-val">0\.0/);
  assert.match(document, /out-track-score">—/);
  assert.match(document, /score-11/);
  assert.ok(!document.includes('<script>'));
  assert.ok(!document.includes('<img src=x'));
  assert.match(document, /&lt;script&gt;/);
  assert.match(document, /script-src 'none'/);
  const tierOnly = buildSavedRatingHtml({ ...stored, final_score: null, tracks: [] });
  assert.ok(!tierOnly.includes('<span class="out-final-avg'));
  assert.match(tierOnly, /B\+/);
});

test('asset allowlist blocks internal hosts, scripts, credentials and deceptive suffixes', () => {
  for (const url of ['http://is1-ssl.mzstatic.com/x', 'https://127.0.0.1/x', 'https://10.0.0.1/x', 'https://fonts.googleapis.com.evil.test/x', 'https://user:pass@is1-ssl.mzstatic.com/x', 'https://is1-ssl.mzstatic.com:8080/x', 'file:///etc/passwd', 'data:image/svg+xml;base64,PHN2Zz4=', 'javascript:alert(1)']) assert.equal(allowedAsset(url), false, url);
  assert.equal(allowedAsset('https://is1-ssl.mzstatic.com/image.jpg'), true);
  assert.equal(allowedAsset('https://lastfm-img.freetls.fastly.net/i/u/770x0/cover.jpg'), true);
  assert.equal(allowedAsset('https://e-cdns-images.dzcdn.net/images/cover/abc/1800x1800.jpg'), true);
  assert.equal(allowedAsset('data:image/png;base64,AAAA'), true);
});

function fakeBrowser({ failScreenshot = false, height = 1200, size = 3 } = {}) {
  const calls = [];
  const page = { setViewport: async () => {}, setRequestInterception: async () => {}, on: () => {}, setContent: async () => {}, evaluate: async () => {},
    $: async () => ({ boundingBox: async () => ({ height }), screenshot: async () => { if (failScreenshot) throw new Error('screenshot failed'); return Buffer.alloc(size); } }) };
  return { calls, browser: { newPage: async () => page, close: async () => calls.push('close') } };
}

test('renderer closes Chromium on success, screenshot failure and excessive height', async () => {
  for (const options of [{}, { failScreenshot: true }, { height: 5000 }]) {
    const fake = fakeBrowser(options);
    const task = renderSavedRating(stored, { launchBrowser: async () => fake.browser });
    if (options.failScreenshot || options.height) await assert.rejects(task);
    else assert.equal((await task).length, 3);
    assert.deepEqual(fake.calls, ['close']);
  }
});

test('attachment compression runs only after Chromium closes', async () => {
  const fake = fakeBrowser({ size: 8 * 1024 * 1024 + 1 });
  const result = await renderSavedRating(stored, { launchBrowser: async () => fake.browser, compress: async () => { assert.deepEqual(fake.calls, ['close']); return Buffer.from('PNG'); } });
  assert.equal(result.toString(), 'PNG');
});

test('renderer watchdog closes a stalled browser', async () => {
  let closed = 0, rejectContent;
  const fake = fakeBrowser();
  const page = await fake.browser.newPage();
  page.setContent = () => new Promise((resolve, reject) => { rejectContent = reject; });
  fake.browser.close = async () => { closed++; if (rejectContent) rejectContent(new Error('Target closed')); };
  await assert.rejects(renderSavedRating(stored, { launchBrowser: async () => fake.browser, renderTimeout: 5 }));
  assert.ok(closed >= 1);
});
