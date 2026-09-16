'use strict';

function maskAchievementDefinitions(definitions,unlocks) {
  const unlockedKeys=new Set((unlocks||[]).map(x=>x.achievement_key));
  let slot=0;
  return (definitions||[]).map(definition=>{
    if(!definition.is_secret)return definition;
    slot+=1;
    return !unlockedKeys.has(definition.key)
      ? {...definition,key:`visible_secret_slot_${slot}`,title:'???',rarity:null,client_metadata:{secret:true,locked:true,locked_label:'Hidden Achievement'}}
      : definition;
  });
}

module.exports={maskAchievementDefinitions};
