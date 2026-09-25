'use strict';
const assert=require('assert');
const Emblem=require('./emblem-rules');

const def=(key,category='Vault',rarity='Common',extra={})=>({key,category,rarity,enabled:true,is_discovery:false,emblem_eligible:true,client_metadata:extra});
const unlock=(key,rarity='Common')=>({id:`u-${key}`,achievement_key:key,level:1,snapshot:{level_rarity:rarity}});
function fixture(n,{vault=0,hybrid=0,listening=0,rarities={},secrets=0,vaultGroups=0,discovery=0,ratedAlbums=0}={}) {
  const definitions=[],unlocks=[]; let i=0;
  const add=(category,secret=false)=>{ const key=`f${i++}`,rarity=Object.entries(rarities).find(([,ids])=>ids.includes(i-1))?.[0]||'Common'; definitions.push(def(key,category,rarity,{secret,vaultCategory:category==='Vault'?`g${(i-1)%Math.max(1,vaultGroups)}`:undefined})); unlocks.push(unlock(key,rarity)); };
  for(let x=0;x<vault;x++)add('Vault',x<secrets); for(let x=0;x<listening;x++)add('Listening',x+vault<secrets); for(let x=0;x<hybrid;x++)add('Hybrid',x+vault+listening<secrets); while(i<n)add('Secret',i<secrets);
  for(let x=0;x<discovery;x++){const key=`d${x}`;definitions.push({...def(key,'Discovery','Mythic',{secret:true}),is_discovery:true,emblem_eligible:false});unlocks.push(unlock(key,'Mythic'));}
  return {definitions,unlocks,ratedAlbumIds:Array.from({length:ratedAlbums},(_,x)=>`a${x}`)};
}
assert.equal(Emblem.evaluate(fixture(1,{vault:1})).highestQualified.id,'seed');
assert.equal(Emblem.evaluate(fixture(7,{vault:5,rarities:{Rare:[0]}})).qualified.some(x=>x.id==='collector'),false);
assert.equal(Emblem.evaluate(fixture(8,{vault:4,listening:4,rarities:{Rare:[0]}})).qualified.some(x=>x.id==='collector'),false);
assert.equal(Emblem.evaluate(fixture(8,{vault:5,listening:3,rarities:{Rare:[0]}})).qualified.some(x=>x.id==='collector'),true);
assert.equal(Emblem.evaluate(fixture(16,{vault:16,vaultGroups:3,rarities:{Epic:[0,1]},ratedAlbums:12})).qualified.some(x=>x.id==='curator'),true);
assert.equal(Emblem.evaluate(fixture(25,{vault:10,listening:10,hybrid:5,rarities:{Epic:[0,1,2]}})).qualified.some(x=>x.id==='archivist'),true);
assert.equal(Emblem.evaluate(fixture(35,{vault:16,listening:16,hybrid:3,rarities:{Legendary:[0]},secrets:2})).qualified.some(x=>x.id==='master_archivist'),true);
assert.equal(Emblem.evaluate(fixture(43,{vault:20,listening:13,hybrid:10,rarities:{Epic:[0,1,2,3,4],Legendary:[5,6,7],Mythic:[8]},secrets:3})).qualified.some(x=>x.id==='vaulted_master'),true);
assert.equal(Emblem.evaluate(fixture(42,{vault:20,listening:12,hybrid:10,rarities:{Epic:[0,1,2,3],Legendary:[4,5],Mythic:[]},secrets:2,discovery:5})).qualified.some(x=>x.id==='vaulted_master'),false);
console.log('emblem-rules.test.js passed');
