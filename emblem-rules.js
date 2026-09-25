'use strict';

const RARITY_ORDER={Common:0,Rare:1,Epic:2,Legendary:3,Mythic:4};
const TIERS=[
  {id:'seed',level:1,title:'Seed',requirements:{families:1}},
  {id:'collector',level:2,title:'Collector',requirements:{families:8,vault:5,Rare:1}},
  {id:'curator',level:3,title:'Curator',requirements:{families:16,Epic:2,ratedAlbums:12,vaultGroups:3}},
  {id:'archivist',level:4,title:'Archivist',requirements:{families:25,Epic:3,categories:['Vault','Listening','Hybrid']}},
  {id:'master_archivist',level:5,title:'Master Archivist',requirements:{families:35,Legendary:1,visibleSecrets:2,hybrid:3}},
  {id:'vaulted_master',level:6,title:'Vaulted Master',requirements:{families:43,Epic:5,Legendary:3,Mythic:1,visibleSecrets:3}}
];

function summarize({definitions=[],unlocks=[],ratedAlbumIds=[]}={}) {
  const definitionsByKey=new Map(definitions.map(row=>[row.key,row]));
  const families=new Map();
  for(const unlock of unlocks) {
    const definition=definitionsByKey.get(unlock.achievement_key);
    if(!definition||definition.enabled===false||definition.is_discovery||definition.emblem_eligible===false)continue;
    const rarity=unlock.snapshot?.level_rarity||definition.rarity;
    const current=families.get(definition.key);
    if(!current||RARITY_ORDER[rarity]>RARITY_ORDER[current.rarity])families.set(definition.key,{definition,rarity,unlockId:unlock.id,level:unlock.level});
  }
  const rows=[...families.values()], countRarity=rarity=>rows.filter(row=>row.rarity===rarity).length;
  const categories=new Set(rows.map(row=>row.definition.category));
  const vaultGroups=new Set(rows.filter(row=>row.definition.category==='Vault').map(row=>row.definition.client_metadata?.vaultCategory||row.definition.metadata?.vaultCategory).filter(Boolean));
  return {
    families:rows.length,
    vault:rows.filter(row=>row.definition.category==='Vault').length,
    listening:rows.filter(row=>row.definition.category==='Listening').length,
    hybrid:rows.filter(row=>row.definition.category==='Hybrid').length,
    visibleSecrets:rows.filter(row=>Boolean(row.definition.is_secret||row.definition.client_metadata?.secret||row.definition.metadata?.secret)).length,
    Rare:countRarity('Rare'),Epic:countRarity('Epic'),Legendary:countRarity('Legendary'),Mythic:countRarity('Mythic'),
    ratedAlbums:new Set(ratedAlbumIds.map(String)).size,vaultGroups:vaultGroups.size,categories:[...categories].sort(),
    familyEvidence:rows.map(row=>({key:row.definition.key,category:row.definition.category,rarity:row.rarity,level:row.level,unlock_id:row.unlockId})).sort((a,b)=>a.key.localeCompare(b.key))
  };
}

function qualifies(tier,m) {
  const r=tier.requirements;
  if(m.families<(r.families||0)||m.vault<(r.vault||0)||m.hybrid<(r.hybrid||0)||m.visibleSecrets<(r.visibleSecrets||0)||m.ratedAlbums<(r.ratedAlbums||0)||m.vaultGroups<(r.vaultGroups||0))return false;
  for(const rarity of ['Rare','Epic','Legendary','Mythic'])if(m[rarity]<(r[rarity]||0))return false;
  return !(r.categories||[]).some(category=>!m.categories.includes(category));
}

function evaluate(input={}) {
  const metrics=summarize(input), qualified=TIERS.filter(tier=>qualifies(tier,metrics));
  return {metrics,qualified,highestQualified:qualified.at(-1)||null};
}

module.exports={RARITY_ORDER,TIERS,summarize,qualifies,evaluate};
