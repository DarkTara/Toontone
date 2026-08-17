const assert=require('assert');
const {deltaE2000,colorScore}=require('../lib/scoring');
const refs=[
  [{L:50,a:2.6772,b:-79.7751},{L:50,a:0,b:-82.7485},2.0425],
  [{L:50,a:3.1571,b:-77.2803},{L:50,a:0,b:-82.7485},2.8615],
  [{L:50,a:2.8361,b:-74.0200},{L:50,a:0,b:-82.7485},3.4412],
  [{L:50,a:-1.3802,b:-84.2814},{L:50,a:0,b:-82.7485},1.0000]
];
for(const [a,b,expected] of refs){assert.ok(Math.abs(deltaE2000(a,b)-expected)<0.0002,`ΔE00 attendu ${expected}`);}
assert.strictEqual(colorScore('#FF7900','#FF7900',2).proximity,100);
assert.ok(colorScore('#FF7900','#F57C00',2).proximity>80);
assert.ok(colorScore('#FF7900','#00AEEF',2).proximity<40);
console.log('✓ CIEDE2000 et score Toon Tone validés');
