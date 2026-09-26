'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const backend = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
assert.match(backend, /app\.post\('\/vault-collection', express\.json\(\{ limit: '8mb' \}\)/, 'collection saves must accept up to 8 MB');
assert.match(backend, /app\.post\('\/vault-collection\/events', express\.json\(\{ limit: '8mb' \}\)/, 'collection+event saves must accept up to 8 MB');

// The frontend is a separate repository in production. When both repositories
// are checked out together, cover the cross-repository persistence contract too.
const frontendPath = path.join(__dirname, '..', 'Album-Vault', 'index.html');
if (fs.existsSync(frontendPath)) {
  const frontend = fs.readFileSync(frontendPath, 'utf8');
  assert.match(frontend, /updatedAt: vaultCollectionUpdatedAt/, 'snapshots must include updatedAt');
  assert.match(frontend, /revision: vaultCollectionRevision/, 'snapshots must include a revision');
  assert.match(frontend, /localBelongsToCurrentUser[\s\S]*isVaultCollectionNewer\(local, remote\)/, 'newer local state must be protected from stale remote state');
  assert.match(frontend, /const saveResult = await flushVaultCollectionSync\(\);/, 'Rater import must await confirmed persistence');
  assert.match(frontend, /const batch = queue\.slice\(0, 30\)/, 'achievement events must respect the server batch limit');

  const freshnessSource = frontend.match(/function vaultCollectionFreshness\(collection\) \{[\s\S]*?\n\}\n\nfunction isVaultCollectionNewer\(candidate, baseline\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(freshnessSource, 'freshness comparison helpers must remain testable');
  const sandbox = {};
  vm.runInNewContext(`${freshnessSource}; this.isNewer = isVaultCollectionNewer;`, sandbox);
  assert.equal(sandbox.isNewer({ updatedAt:'2026-09-26T10:00:01Z', revision:1 }, { updatedAt:'2026-09-26T10:00:00Z', revision:99 }), true, 'newer timestamp must win');
  assert.equal(sandbox.isNewer({ updatedAt:'2026-09-26T10:00:00Z', revision:99 }, { updatedAt:'2026-09-26T10:00:01Z', revision:1 }), false, 'older timestamp must not win');
  assert.equal(sandbox.isNewer({ revision:2 }, { revision:1 }), true, 'revision must break ties for legacy timestamps');
}

console.log('vault persistence regression tests passed');
