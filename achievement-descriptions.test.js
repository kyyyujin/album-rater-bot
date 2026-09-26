'use strict';
const assert=require('assert');
const Rules=require('./achievement-rules');
const Discovery=require('./discovery-rules');
const descriptions=require('./achievement-descriptions');

const normal=Rules.DEFINITIONS.filter(row=>!row.metadata?.secret&&!row.metadata?.discovery);
const secrets=Rules.DEFINITIONS.filter(row=>row.metadata?.secret);
assert.strictEqual(normal.length,46,'the public catalogue has 46 non-secret achievements');
assert.strictEqual(Object.keys(descriptions).length,normal.length,'copy exists only for every non-secret achievement');
for(const definition of normal){
  assert.strictEqual(typeof definition.metadata?.description,'string',`${definition.key} has public requirement copy`);
  assert.ok(definition.metadata.description.trim().length>=20,`${definition.key} copy is meaningful`);
  assert.strictEqual(definition.metadata.description,descriptions[definition.key],`${definition.key} uses canonical copy`);
}
for(const definition of secrets)assert.strictEqual(definition.metadata?.description,undefined,`${definition.key} has no secret description`);
for(const definition of Discovery.DEFINITIONS)assert.strictEqual(definition.metadata?.description,undefined,`${definition.key} has no Discovery description`);
for(const key of Object.keys(descriptions))assert.ok(normal.some(row=>row.key===key),`${key} belongs to a non-secret definition`);
console.log('achievement descriptions: ok');
