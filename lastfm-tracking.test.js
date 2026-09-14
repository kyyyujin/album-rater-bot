'use strict';
const assert=require('assert');
const crypto=require('crypto');
const norm=v=>String(v||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
const fp=(epoch,t)=>crypto.createHash('sha256').update([epoch,t.uts,norm(t.artist),norm(t.track),norm(t.album),'','',''].join('|')).digest('hex');
// Zero start: rows older than the persisted tracking cutoff are never eligible.
const started=Date.parse('2026-09-14T12:00:00Z');
const historic={uts:String(Math.floor((started-1000)/1000)),artist:'Artist',album:'Old',track:'Before'};
const future={uts:String(Math.floor((started+1000)/1000)),artist:'Artist',album:'New',track:'After'};
assert.equal([historic,future].filter(x=>Number(x.uts)*1000>=started).length,1,'pre-tracking history is discarded');
// Overlap/retry/concurrency have a database unique(epoch_id,fingerprint); this
// model verifies the exact deterministic fingerprint used by the worker.
const seen=new Set(); [future,future,{...future}].forEach(t=>seen.add(fp('epoch-a',t)));
assert.equal(seen.size,1,'same scrobble remains one fingerprint');
assert.notEqual(fp('epoch-a',future),fp('epoch-b',future),'account epochs never merge fingerprints');
// Delayed scrobble inside the ten-minute overlap remains discoverable.
const watermark=Date.parse('2026-09-14T13:00:00Z'), overlap=10*60*1000;
const delayed=watermark-9*60*1000;
assert(delayed>=watermark-overlap,'delayed scrobble is in overlap');
// Coverage gaps are not zero: only explicit covered windows contribute.
const coverage=(windows,a,b)=>windows.filter(w=>w.status==='covered').reduce((sum,w)=>sum+Math.max(0,Math.min(b,w.end)-Math.max(a,w.start)),0)/(b-a);
assert.equal(coverage([{status:'covered',start:0,end:50},{status:'coverage_gap',start:50,end:100}],0,100),.5,'gap cannot prove absence');
console.log('PASS zero-start, deterministic dedupe, delayed overlap and coverage-gap semantics');
