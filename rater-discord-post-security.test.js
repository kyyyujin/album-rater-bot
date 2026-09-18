'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const backend = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const frontend = fs.readFileSync(path.join(root, '..', 'Rater-Page', 'index.html'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'migrations', '20260918003000_rater_discord_post_security.sql'), 'utf8');

const postStart = backend.indexOf("app.post('/post'");
const postEnd = backend.indexOf("app.post('/delete'", postStart);
assert.ok(postStart >= 0 && postEnd > postStart, 'POST /post must exist as a bounded route');
const postRoute = backend.slice(postStart, postEnd);

assert.match(postRoute, /verifyTokenFromStore\(auth_token\)/, 'POST /post must authenticate its caller');
assert.match(postRoute, /getRaterDiscordThreadId\(username\)/, 'POST /post must read the destination server-side');
assert.doesNotMatch(postRoute, /req\.body\??\.thread_id|req\.body\.thread_id/, 'POST /post must not read a browser thread_id');
assert.doesNotMatch(postRoute, /req\.body\??\.user_id|req\.body\.user_id/, 'POST /post must not read a browser user_id');
assert.doesNotMatch(postRoute, /const\s*\{[^}]*\bthread_id\b[^}]*\}\s*=\s*req\.body/, 'POST /post must not destructure a browser thread_id');
assert.doesNotMatch(postRoute, /const\s*\{[^}]*\buser_id\b[^}]*\}\s*=\s*req\.body/, 'POST /post must not destructure a browser user_id');
assert.match(migration, /create table if not exists public\.rater_discord_settings/i, 'settings migration must exist');
assert.match(migration, /enable row level security/i, 'settings must have RLS enabled');
assert.match(migration, /revoke all on table public\.rater_discord_settings from anon, authenticated/i, 'browser roles must have no table grants');
assert.match(frontend, /formData\.append\('auth_token', authToken\)/, 'Rater must authenticate posting');
assert.doesNotMatch(frontend, /formData\.append\('thread_id'/, 'Rater must not send a destination with an album post');
assert.match(frontend, /\/rater\/discord-settings/, 'Rater must save its private destination through the authenticated route');

console.log('rater discord posting security tests passed');
