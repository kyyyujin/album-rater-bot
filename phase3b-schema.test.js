'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path');
const sql=fs.readFileSync(path.join(__dirname,'migrations/20260916190000_phase3b_hybrid_visible_secrets.sql'),'utf8');
for(const needle of ['listening_period_closer_state','listening_period_snapshots','hybrid_count_scrobble_windows','hybrid_coverage_evidence','enable row level security','listening_period_snapshots_immutable','album_vault_achievement_period_close','17 * * * *'])assert(sql.includes(needle),`missing ${needle}`);
assert(/unique\(user_id,epoch_id,period_type,local_start\)/i.test(sql));
assert(!/update\s+public\.listening_scrobbles/i.test(sql),'Phase 3B migration must not rewrite raw scrobbles');
assert(!/lastfm_tracking_started_at\s*=/i.test(sql),'Phase 3B migration must not move the tracking cutoff');
console.log('phase3b schema invariants passed');
