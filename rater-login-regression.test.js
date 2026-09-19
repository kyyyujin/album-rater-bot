'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const frontend = fs.readFileSync(path.join(__dirname, '..', 'Rater-Page', 'index.html'), 'utf8');

assert.match(frontend, /async function fetchNowPlaying\(\)/, 'Last.fm Now Playing implementation must exist');
assert.match(frontend, /let _npInterval = null;/, 'Now Playing polling state must exist');
assert.match(frontend, /function hideNowPlaying\(\)/, 'Now Playing hide helper must exist');
assert.match(frontend, /function startNowPlayingPolling\(\)/, 'Now Playing scheduler must exist');

const initStart = frontend.indexOf('function initApp()');
const initEnd = frontend.indexOf('// ── Chip de sesión', initStart);
assert.ok(initStart >= 0 && initEnd > initStart, 'initApp must exist as a bounded function');
const initApp = frontend.slice(initStart, initEnd);
assert.ok(
  initApp.indexOf('renderUserSessionChip();') < initApp.indexOf('startNowPlayingPolling();'),
  'Authenticated identity must render before optional Now Playing starts'
);

console.log('rater login regression tests passed');
