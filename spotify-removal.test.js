'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const backend = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const frontend = fs.readFileSync(path.join(__dirname, '..', 'Rater-Page', 'index.html'), 'utf8');
const serviceWorker = fs.readFileSync(path.join(__dirname, '..', 'Rater-Page', 'sw.js'), 'utf8');

assert.doesNotMatch(backend, /spotify/i, 'The backend must not expose Spotify routes or access Spotify data.');
assert.doesNotMatch(frontend, /spotify/i, 'The Rater must not contain Spotify UI, imports, or client-side processing.');
assert.doesNotMatch(frontend, /spData|SP_STORAGE_KEY|albumrater_spdata/i, 'The Rater must not load or retain the former stream cache.');
assert.doesNotMatch(frontend, /jszip/i, 'The former Spotify archive parser must not be loaded.');
assert.doesNotMatch(serviceWorker, /spotify|jszip/i, 'The service worker must not cache the former Spotify parser.');
assert.match(frontend, /startNowPlayingPolling/, 'Last.fm Now Playing polling must remain available.');
assert.match(frontend, /\/lastfm\?method=/, 'Existing Last.fm proxy usage must remain available.');

console.log('spotify removal tests passed');
