const {test}=require('node:test'), assert=require('node:assert/strict'), vm=require('node:vm'), fs=require('node:fs');
const source=fs.readFileSync(require.resolve('../extension/content.js'),'utf8');
async function simulate(action,{active=false,zero=false,deny=false,member='Gwen',text='hello',changed=false}={}) {
  let ack, clicks=[], inspect, sent=false, generating=false, counterZero=zero;
  class TextArea {constructor(){this.text='';} get value(){return this.text;} set value(v){this.text=v;} getClientRects(){return [{}];} getAttribute(){return null;} focus(){} dispatchEvent(){} }
  const input=new TextArea();
  const base=()=>({getClientRects:()=>[{}],getAttribute:()=>null,isConnected:true});
  const auto={...base(),getAttribute:name=>name==='data-variant'&&active?'primary':null,parentElement:{querySelector:()=>active?{textContent:counterZero?'0':'10'}:null},click(){active=!active;counterZero=false;clicks.push(active?'play':'pause');}};
  const portrait={...base(),getAttribute:()=> 'Gwen',click(){clicks.push('invite');generating=true;}};
  const send={...base(),click(){clicks.push('say');input.value='';setImmediate(()=>setImmediate(()=>setImmediate(()=>messages.push({...base(),querySelector:s=>s.includes('nomiName')?null:{innerText:text}}))));}};
  const messages=[];
  const context={location:{hostname:'beta.nomi.ai',pathname:'/group-chats/1',href:'https://beta.nomi.ai/group-chats/1'},crypto:globalThis.crypto,
    HTMLTextAreaElement:TextArea,HTMLInputElement:class{},Event:class{},getComputedStyle:()=>({visibility:'visible'}),
    setInterval:()=>{},setTimeout:fn=>setImmediate(fn),document:{title:'Group',querySelectorAll(sel){
      if(sel==='textarea[aria-label="Group Chat Input"]')return [input];
      if(sel==='button[aria-label="Send message"]')return input.value?[send]:[];
      if(sel==='button[aria-label="Auto Chat"]')return input.value?[]:[auto];
      if(sel.includes('groupChatMembers'))return [portrait];
      if(sel.includes('GroupChatMessageBubble_wrapper'))return messages;
      if(sel.includes('TypingBubble'))return generating?[base()]:[];
      return [];
    }},chrome:{storage:{local:{get:async()=>({})},onChanged:{addListener:()=>{}}},runtime:{onMessage:{addListener:fn=>inspect=fn},sendMessage:async m=>{
      if(m.path==='/api/heartbeat') {if(sent)return {};sent=true;return {command:{id:'cmd',groupCommand:true,action,member,text,roomKey:m.data.snapshot.roomKey,url:context.location.href,document:m.data.snapshot.document}};}
      if(m.path==='/api/claim') {
        if(m.data.checkOnly && changed) messages.push({getClientRects:()=>[{}],querySelector:s=>s.includes('nomiName')?{textContent:'Gwen'}:{innerText:'new room message'}});
        return {allowed:!(deny&&m.data.checkOnly)};
      }
      if(m.path==='/api/ack'){ack=m.data;return {};}
    }}}};
  vm.runInNewContext(source,context);
  for(let i=0;i<300&&!ack;i++)await new Promise(r=>setImmediate(r));
  let snapshot;inspect({type:'inspect'},null,r=>snapshot=r.snapshot);
  return {ack,clicks,snapshot,input};
}
test('room snapshot distinguishes active Auto Chat waiting at zero from paused',async()=>{
 const r=await simulate('pause',{active:true,zero:true,deny:true}); assert.equal(r.snapshot.autoChat,'enabled'); assert.equal(r.snapshot.userTurn,true); assert.equal(r.snapshot.members[0],'Gwen'); assert.deepEqual(r.clicks,[]);
});
test('Play at zero pauses then resumes, without sending text',async()=>{
 const r=await simulate('play',{active:true,zero:true}); assert.deepEqual(r.clicks,['pause','play']); assert.equal(r.ack.error,undefined); assert.equal(r.snapshot.autoChat,'enabled');assert.equal(r.snapshot.userTurn,false);
});
test('Play already running is idempotent; Pause pauses once',async()=>{
 const a=await simulate('play',{active:true});assert.deepEqual(a.clicks,[]);assert.equal(a.ack.error,undefined);
 const b=await simulate('pause',{active:true});assert.deepEqual(b.clicks,['pause']);assert.equal(b.ack.error,undefined);
});
test('Invite selects named member and confirms generation',async()=>{
 const r=await simulate('invite');assert.deepEqual(r.clicks,['invite']);assert.equal(r.ack.error,undefined);
 const missing=await simulate('invite',{member:'Nobody'});assert.deepEqual(missing.clicks,[]);assert.match(missing.ack.error,/missing/);
});
test('Stop immediately before control action prevents click',async()=>{
 const r=await simulate('play',{deny:true});assert.deepEqual(r.clicks,[]);assert.match(r.ack.error,/Stopped/);
});
test('room send accepts 800 characters, rejects 801, and never sends control tags',async()=>{
 const r=await simulate('say',{text:'x'.repeat(800)});assert.deepEqual(r.clicks,['say']);assert.equal(r.ack.error,undefined);
 assert.equal(r.ack.snapshot.messages.at(-1).text,'x'.repeat(800));
 const big=await simulate('say',{text:'x'.repeat(801)});assert.deepEqual(big.clicks,[]);assert.match(big.ack.error,/800/);
});
test('new room message during final send authorization prevents a stale send',async()=>{
 const r=await simulate('say',{changed:true});assert.deepEqual(r.clicks,[]);assert.match(r.ack.error,/Room changed/);
});
