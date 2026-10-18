const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
test('Heartbeat interface sends one GPT tab, phrase and default delay',async()=>{
 const {elements,payloads}=await setup();elements.mode.value='heartbeat';elements.mode.onchange();elements.nomi.value='';
 assert.equal(elements['heartbeat-options'].hidden,false);assert.equal(elements.nomi.hidden,true);
 elements['heartbeat-text'].value='Keep going';elements.play.onclick();await new Promise(r=>setImmediate(r));
 const play=payloads.find(m=>m.path==='/api/play');assert.deepEqual(Array.from(play.data.tabs),['1']);assert.equal(play.data.heartbeatText,'Keep going');assert.equal(play.data.heartbeatDelay,10);
});
async function setup({blockedStorage=false,rejectPlay=false, sites=['chatgpt','nomi'],room=false}={}) {
 const ids=['heartbeat-options','heartbeat-text','heartbeat-delay','mode','group-help','room-state','build-version','chatgpt','nomi','first','settle','play','stop','reset','status','error','count','tabs','events','copy-status','api-options','api-nomi','api-room','api-key','save-api-key','clear-api-key','refresh-api','api-room-name','create-api-room','api-key-status','api-status','api-recovery','api-recovery-state','api-recover-send','api-recover-reply','api-abandon','api-new-room-description','api-room-editor','api-room-description','api-save-description','api-delete-room','api-monitor-live','api-monitor-tab','api-monitor-idle','api-monitor-status','api-journal-tools','api-journal-status','api-clear-journal'];
 const elements=Object.fromEntries(ids.map(id=>[id,{value:'',textContent:'',replaceChildren(){},closest(){return this;},disabled:false}]));
 const calls=[];const payloads=[];const state={running:false,reason:'Ready',turns:0,events:[],tabs:[{id:'1',site:sites[0],connected:true},{id:'2',site:sites[1],room,connected:true}]};
 const context={document:{getElementById:id=>elements[id],createElement:()=>({})},Option:class{},setTimeout,clearTimeout,setInterval:()=>{},
 localStorage:{getItem(){if(blockedStorage)throw Error('Storage blocked');return '';},setItem(){if(blockedStorage)throw Error('Storage blocked');}},
 chrome:{runtime:{getManifest:()=>({version:'0.1.8'}),sendMessage:async m=>{calls.push(m.path);payloads.push(m);if(m.path==='/api/play'&&rejectPlay)return {error:'Clear the draft in both chats first.'};return state;}}}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../extension/dashboard.js'),'utf8'),context);
 await new Promise(r=>setImmediate(r));return {elements,calls,payloads};
}
test('Play works even when selection storage is blocked',async()=>{
 const {elements,calls}=await setup({blockedStorage:true});elements.play.onclick();assert.equal(elements.status.textContent,'Starting…');await new Promise(r=>setImmediate(r));assert.ok(calls.includes('/api/play'));
});
test('Play errors appear immediately beside the control status',async()=>{
 const {elements}=await setup({rejectPlay:true});elements.play.onclick();await new Promise(r=>setImmediate(r));assert.equal(elements.status.textContent,'Clear the draft in both chats first.');assert.equal(elements.play.disabled,false);
});
test('missing selected tabs produce feedback rather than an inert click',async()=>{
 const {elements,calls}=await setup();elements.nomi.value='';elements.play.onclick();assert.match(elements.status.textContent,/Select both/);assert.ok(!calls.includes('/api/play'));
});

for (const site of ['chatgpt','nomi']) {
 test(`controls allow two ${site} chats`,async()=>{
  const {elements,payloads}=await setup({sites:[site,site]});
  assert.notEqual(elements.chatgpt.value,elements.nomi.value);
  elements.first.value='second';elements.play.onclick();
  await new Promise(r=>setImmediate(r));
  const play=payloads.find(m=>m.path==='/api/play');
  assert.deepEqual(Array.from(play.data.tabs),['1','2']);assert.equal(play.data.first,'second');
 });
}
test('controls reject selecting the same tab twice',async()=>{
 const {elements,calls}=await setup();elements.nomi.value=elements.chatgpt.value;elements.play.onclick();
 assert.match(elements.status.textContent,/different/);assert.ok(!calls.includes('/api/play'));
});

test('group interface sends mode, shows help and disables first-speaker choice',async()=>{
 const {elements,payloads}=await setup({room:true});
 elements.mode.value='group';elements.mode.onchange();
 assert.equal(elements['group-help'].hidden,false);assert.equal(elements.first.disabled,true);
 elements.play.onclick();await new Promise(r=>setImmediate(r));
 const play=payloads.find(m=>m.path==='/api/play');assert.equal(play.data.mode,'group');assert.deepEqual(Array.from(play.data.tabs),['1','2']);
});
