'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path');
const sql=fs.readFileSync(path.join(__dirname,'migrations/20260925062517_phase4b_feature_complete.sql'),'utf8');
const indexes=fs.readFileSync(path.join(__dirname,'migrations/20260925063130_phase4b_fk_indexes.sql'),'utf8');
for(const token of ['vault_emblem_state','vault_emblem_upgrades','vault_cosmetic_entitlements','vault_achievement_prevalence','achievement_temporal_listening_evidence','enable row level security','eligible_population>=30','prevent_phase4b_evidence_mutation'])assert(sql.includes(token),token);
for(const role of ['anon','authenticated'])assert(sql.includes(`from public,${role}`)||sql.includes(`,${role}`),role);
assert(!/grant\s+select[^;]+\s+to\s+(anon|authenticated)/i.test(sql));
for(const token of ['source_achievement_key','source_unlock_id','user_id,equipped_key'])assert(indexes.includes(token),token);
console.log('phase4b-schema.test.js passed');
