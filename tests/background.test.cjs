const {test}=require('node:test');const assert=require('node:assert/strict');
const vm=require('node:vm');const fs=require('node:fs');const {Bridge}=require('../extension/engine.js');
test('receiving tab is activated before delivering the send command',async()=>{
 let listener;const order=[];const b=new Bridge();
 const now=b.clock();
 const snapshot={site:'nomi',ready:true,busy:false,draft:false,reply:'old',replyKey:'old',url:'https://beta.nomi.ai/nomis/test',document:'doc'};
 b.tabs={'1':{...snapshot,site:'chatgpt',seen:now},'2':{...snapshot,seen:now,changed:now}};
 b.running=true;b.pair=['1','2'];b.phase='send';b.command={id:'c',target:'2',text:'hi',claimed:false,created:now,source:'1',sourceReply:'old',sourceKey:'old',sourceDocument:'doc',sourceUrl:snapshot.url};
 const context={Bridge,GroupBridge:require('../extension/group.js').GroupBridge,setTimeout,clearTimeout,importScripts:()=>{},chrome:{runtime:{onMessage:{addListener:fn=>listener=fn},getURL:()=> 'chrome-extension://test/'},
 storage:{session:{get:async()=>({bridge:b.serialize()}),set:async()=>order.push('saved')}},
 alarms:{create:()=>{},onAlarm:{addListener:()=>{}}},tabs:{sendMessage:async()=>({snapshot}),update:async(id,options)=>{assert.equal(id,2);assert.equal(options.active,true);order.push('activated');},onRemoved:{addListener:()=>{}}}}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../extension/background.js'),'utf8'),context);
 const response=await new Promise(resolve=>listener({path:'/api/heartbeat',data:{snapshot}}, {tab:{id:2,windowId:1},url:snapshot.url},r=>{order.push('delivered');resolve(r);}));
 assert.equal(response.command.id,'c');assert.deepEqual(order,['activated','saved','delivered']);
});
