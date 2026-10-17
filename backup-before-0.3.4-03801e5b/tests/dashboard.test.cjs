const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
async function setup({blockedStorage=false,rejectPlay=false, sites=['chatgpt','nomi']}={}) {
 const ids=['build-version','chatgpt','nomi','first','settle','play','stop','reset','status','error','count','tabs','events','copy-status'];
 const elements=Object.fromEntries(ids.map(id=>[id,{value:'',textContent:'',replaceChildren(){},disabled:false}]));
 const calls=[];const payloads=[];const state={running:false,reason:'Ready',turns:0,events:[],tabs:[{id:'1',site:sites[0],connected:true},{id:'2',site:sites[1],connected:true}]};
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
