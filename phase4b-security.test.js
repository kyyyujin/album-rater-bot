'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path');
const server=fs.readFileSync(path.join(__dirname,'index.js'),'utf8');
const frontend=fs.readFileSync(path.join(__dirname,'../Album-Vault/index.html'),'utf8');
for(const route of ['/achievements/emblem/acknowledge','/achievements/cosmetics/equip']){
  const start=server.indexOf(`app.post('${route}'`),body=server.slice(start,start+1400);assert(start>=0,route);assert(body.includes('isAchievementBetaUser(username)'),`${route} beta authorization`);
}
assert(server.includes("is_discovery=eq.false"),'prevalence excludes Discovery');
assert(server.includes('eligible_population=gte.30'),'prevalence k-anonymity');
assert(frontend.includes("if (!isAchievementBetaUser()) return"),'frontend beta gate');
assert(frontend.includes("rating-ceremony').classList.contains('active')"),'rating ceremony priority');
assert(server.includes('if(isSecret||isDiscovery)delete clientMetadata.description'),'server strips descriptions from every secret definition');
assert(frontend.includes("description=!secret&&!discovery?String(d.client_metadata?.description||'').trim():''"),'frontend renders descriptions only for non-secret achievements');
assert(frontend.includes('class="achievement-description"'),'frontend includes the public requirement copy');
console.log('phase4b security tests passed');
