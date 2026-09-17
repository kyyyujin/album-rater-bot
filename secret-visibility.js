'use strict';

function maskAchievementDefinitions(definitions,unlocks) {
  const unlockedKeys=new Set((unlocks||[]).map(x=>x.achievement_key));
  let slot=0;
  return (definitions||[]).filter(definition=>!definition.is_discovery||unlockedKeys.has(definition.key)).map(definition=>{
    if(!definition.is_secret)return definition;
    slot+=1;
    return !unlockedKeys.has(definition.key)
      ? {...definition,key:`visible_secret_slot_${slot}`,title:'???',rarity:null,client_metadata:{secret:true,locked:true,locked_label:'Hidden Achievement'}}
      : definition;
  });
}

function achievementTrustBoundary({definitions=[],progress=[],artistProgress=[],unlocks=[],showcase=[],inbox=[]}={}) {
  const discoveryKeys=new Set(definitions.filter(row=>row.is_discovery).map(row=>row.key));
  const unlockedKeys=new Set(unlocks.map(row=>row.achievement_key));
  const lockedDiscovery=new Set([...discoveryKeys].filter(key=>!unlockedKeys.has(key)));
  const visibleDefinitions=maskAchievementDefinitions(definitions,unlocks);
  const allowedKeys=new Set(visibleDefinitions.map(row=>row.key));
  // Progress is never exposed for Discovery families, even after reveal: a
  // Discovery is an atomic story, not a client-visible checklist.
  return {
    definitions:visibleDefinitions,
    progress:progress.filter(row=>!discoveryKeys.has(row.achievement_key)),
    artistProgress:artistProgress.filter(row=>!discoveryKeys.has(row.achievement_key)),
    unlocks:unlocks.filter(row=>!lockedDiscovery.has(row.achievement_key)),
    showcase:showcase.filter(row=>!lockedDiscovery.has(row.achievement_key)),
    inbox:inbox.filter(row=>!lockedDiscovery.has(row.achievement_key)),
    availableCount:allowedKeys.size
  };
}

module.exports={maskAchievementDefinitions,achievementTrustBoundary};
