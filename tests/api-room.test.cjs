const {test}=require('node:test');
const assert=require('node:assert/strict');
globalThis.crypto ||= require('node:crypto').webcrypto;
const {GroupBridge}=require('../extension/group.js');
const utils=require('../extension/api-room.js');
globalThis.NomiApiRoom=utils;
const {ApiRoomCheckpoint}=require('../extension/api-checkpoint.js');
globalThis.ApiRoomCheckpoint=ApiRoomCheckpoint;
const {NomiApiDriver}=require('../extension/api-driver.js');
const ROOM='12345678-1234-1234-1234-123456789012';
const NOMI='22222222-2222-2222-2222-222222222222';
const GPT_ID='123';
const virtual=utils.apiRoomId(ROOM);

function harness(reply='This is a World Engine turn. '+('🌲 '.repeat(750))) {
  let seconds=100;
  const b=new GroupBridge(()=>seconds);
  const local=new Map();
  const storage={
    async get(key){
      if(typeof key==='string')return {[key]:local.get(key)};
      return Object.fromEntries(Object.keys(key||{}).map(k=>[k,local.get(k)]));
    },
    async set(value){for(const [k,v] of Object.entries(value))local.set(k,structuredClone(v));},
    async remove(key){local.delete(key);}
  };
  const source={site:'chatgpt',reply,replyKey:'reply-1',url:'https://chatgpt.com/c/world',
    document:'test-doc',ready:true,complete:true,busy:false,draft:false,error:''};
  const destination={site:'api-room',reply:'',replyKey:'',url:'api-room:'+ROOM,document:virtual,
    ready:true,complete:true,busy:false,draft:false,error:''};
  globalThis.chrome={storage:{local:storage},
    tabs:{sendMessage:async()=>({snapshot:{...source}})}};
  b.heartbeat(GPT_ID,source);b.heartbeat(virtual,destination);
  b.apiSession={roomId:ROOM,nomiUuid:NOMI,nomiName:'Gwen',roomName:'World',
    pendingReply:'none',sequence:0};
  b.start({mode:'api-room',tabs:[GPT_ID,virtual],first:'first',settle:8});
  seconds+=9;b.heartbeat(GPT_ID,source);b.heartbeat(virtual,destination);
  assert.equal(b.command?.text,reply);
  const cp=new ApiRoomCheckpoint(storage);
  const driver=new NomiApiDriver(()=>b,async operation=>operation(),cp);
  driver.delay=async()=>{};
  const settle=async()=>{for(let i=0;i<30;i++)await new Promise(resolve=>setImmediate(resolve));};
  return {b,driver,storage,cp,source,reply,settle,stop:()=>b.stop()};
}
test('API room chunking is lossless in 800 UTF-8 byte POSTs with no total character cap',()=>{
  for(const str of ['x'.repeat(100000),'😀'.repeat(2000),
    'é漢🌲'.repeat(1500),'paragraph one.\n\n'.repeat(4000),'x'.repeat(799)+'😀']) {
    const parts=utils.apiChunks(str);
    assert.equal(parts.join(''),str);
    assert.ok(parts.every(s=>Buffer.byteLength(s,'utf8')<=800));
    assert.ok(parts.every(s=>!/[\uD800-\uDBFF]$/.test(s)));
  }
});
test('one complete GPT turn delivers every chunk, then asks one Nomi reply',async()=>{
  const h=harness(),sent=[];
  let requests=0;
  h.driver.request=async(path,method='GET',body)=>{
    if(path.endsWith('/chat')){sent.push(body.messageText);return {};}
    if(path.endsWith('/chat/request')){requests++;return {replyMessage:{messageText:'Gwen is ready.'}};}
    throw Error('Unexpected '+path);
  };
  await h.driver.pump();await h.settle();
  assert.equal(sent.join(''),h.reply);
  assert.equal(sent.length,utils.apiChunks(h.reply).length);
  assert.equal(requests,1);
  assert.equal(h.b.tabs[virtual].reply,'Gwen is ready.');
  assert.equal(h.b.turns,1);
  let state=await h.cp.load(ROOM);
  assert.equal(state.status,'reply_received','reply is retained until ChatGPT acknowledges');
  await h.driver.forwarded(ROOM);
  state=await h.cp.load(ROOM);
  assert.equal(state.status,'completed');
  assert.equal(state.text,null);
  assert.equal(state.reply,null);
});
test('ambiguous second POST never auto retries; confirmed first chunk is preserved',async()=>{
  const h=harness('z'.repeat(1850)),sent=[];
  h.driver.request=async(path,method='GET',body)=>{
    if(path.endsWith('/chat')){
      sent.push(body.messageText);
      if(sent.length===2)throw Error('502 after potentially successful remote POST');
      return {};
    }
    throw Error('Reply cannot start after partial content');
  };
  await h.driver.pump();await h.settle();
  const cp=await h.cp.load(ROOM);
  assert.equal(cp.status,'send_uncertain');
  assert.equal(cp.confirmed,1);
  assert.equal(cp.attemptedIndex,2);
  assert.equal(h.b.running,false);
  await h.driver.pump();
  assert.equal(sent.length,2);
});
test('operator-authorized send recovery never repeats earlier confirmed chunks',async()=>{
  const h=harness('z'.repeat(1850)),sent=[];
  let fail=true,replies=0;
  h.driver.request=async(path,method='GET',body)=>{
    if(path.endsWith('/chat')){
      sent.push(body.messageText);
      if(fail&&sent.length===2){fail=false;throw Error('Ambiguous gateway failure');}
      return {};
    }
    if(path.endsWith('/chat/request')){replies++;return {replyMessage:{messageText:'Recovered.'}};}
    throw Error('Unexpected '+path);
  };
  await h.driver.pump();await h.settle();
  const cp=await h.cp.load(ROOM);
  assert.equal(cp.status,'send_uncertain');
  await h.driver.recover(ROOM,'send',{nomiUuid:NOMI,chatgptTab:GPT_ID});
  await h.settle();
  assert.equal(sent.length,4,'two attempts at chunk 2, one each at chunks 1 and 3');
  assert.equal(sent[0],utils.apiChunks(h.reply)[0]);
  assert.equal(sent[1],sent[2],'only uncertain chunk 2 may repeat');
  assert.equal(sent[3],utils.apiChunks(h.reply)[2]);
  assert.equal(replies,1);
  assert.equal(h.b.tabs[virtual].reply,'Recovered.');
  const events=(await h.cp.load(ROOM)).events.map(e=>e.type);
  assert.ok(events.includes('send_retry_authorized'));
});
test('explicit NoReply retries reply request with exponential backoff, not World Engine content',async()=>{
  const h=harness('Hello Gwen.'),sent=[],delays=[];
  let replies=0;
  h.driver.delay=async ms=>delays.push(ms);
  h.driver.request=async(path,method='GET',body)=>{
    if(path.endsWith('/chat')){sent.push(body.messageText);return {};}
    if(path.endsWith('/chat/request')){
      replies++;
      if(replies<=3){const err=Error('Nomi not ready');err.httpStatus=400;err.apiType='RoomNomiNotReadyForMessage';throw err;}
      return {replyMessage:{messageText:'Here now'}};
    }
    throw Error('Unexpected '+path);
  };
  await h.driver.pump();await h.settle();
  assert.equal(sent.length,1);
  assert.equal(replies,4);
  assert.deepEqual(delays,[1000,2000,4000]);
  assert.equal((await h.cp.load(ROOM)).status,'reply_received');
});
test('reply request with ambiguous outcome cannot be retried without operator consent',async()=>{
  const h=harness('Hello'),sent=[];
  let requests=0;
  h.driver.request=async(path,method='GET',body)=>{
    if(path.endsWith('/chat')){sent.push(body.messageText);return {};}
    if(path.endsWith('/chat/request')){requests++;throw Error('Timeout after Nomi may have replied');}
    throw Error('Unexpected '+path);
  };
  await h.driver.pump();await h.settle();
  const cp=await h.cp.load(ROOM);
  assert.equal(cp.status,'reply_uncertain');
  assert.equal(h.b.running,false);
  await h.driver.pump();
  assert.equal(requests,1);
  assert.equal(sent.length,1);
});
test('read-only API requests retry 8 transient errors; content POSTs never auto retry',async()=>{
  const h=harness('Hi');
  let count=0;
  h.driver.delay=async()=>{};
  const original=globalThis.fetch;
  globalThis.fetch=async()=>{
    count++;
    if(count<8)return {ok:false,status:503,json:async()=>({error:{type:'TooManyRequests'}})};
    return {ok:true,status:200,json:async()=>({rooms:[]})};
  };
  try{
    await h.storage.set({nomiApiKey:'fake-unit-test-key'});
    await h.driver.request('/rooms');
    assert.equal(count,8);
    count=0;
    await assert.rejects(()=>h.driver.request('/rooms/'+ROOM+'/chat','POST',{messageText:'test'}));
    assert.equal(count,1);
  }finally{globalThis.fetch=original;}
});

test('room catalog exposes notes without exposing API credentials',async()=>{
  const h=harness('hello');
  h.driver.request=async(path)=>{
    if(path==='/nomis')return {nomis:[{uuid:NOMI,name:'Gwen'}]};
    if(path==='/rooms')return {rooms:[{uuid:ROOM,name:'WORLD::Gwen',note:'Hungry after the morning walk',backchannelingEnabled:true,nomis:[{uuid:NOMI,name:'Gwen'}]}]};
    throw Error('Unexpected '+path);
  };
  const catalog=await h.driver.catalog();
  assert.equal(catalog.rooms[0].note,'Hungry after the morning walk');
  assert.equal(catalog.rooms[0].backchannelingEnabled,true);
  assert.deepEqual(catalog.rooms[0].nomiUuids,[NOMI]);
});
test('editing room note only changes note, never backchanneling or membership',async()=>{
  const h=harness('hello');
  h.stop();
  const posts=[],old='You are feeling hungry';
  let note=old;
  h.driver.request=async(path,method='GET',body)=>{
    if(path==='/rooms/'+ROOM && method==='GET')return {room:{uuid:ROOM,name:'WORLD::Gwen',note,backchannelingEnabled:true}};
    if(path==='/rooms/'+ROOM && method==='PUT'){posts.push(body);note=body.note;return {room:{uuid:ROOM,note}};}
    throw Error('Unexpected '+path);
  };
  const result=await h.driver.updateRoomNote(ROOM,'You are getting sleepy',old);
  assert.equal(result.updated,true);
  assert.deepEqual(posts,[{note:'You are getting sleepy'}]);
  assert.equal(note,'You are getting sleepy');
  await assert.rejects(()=>h.driver.updateRoomNote(ROOM,'Another state',old));
  assert.equal(posts.length,1,'stale edit must not overwrite newer room context');
  await assert.rejects(()=>h.driver.updateRoomNote(ROOM,'x'.repeat(1001),note));
});
test('room deletion requires exact name and confirmed DELETE before removing checkpoint',async()=>{
  const h=harness('hello');
  const requests=[];
  h.stop();
  h.driver.request=async(path,method='GET')=>{
    requests.push(method+' '+path);
    if(path==='/nomis')return {nomis:[{uuid:NOMI,name:'Gwen'}]};
    if(path==='/rooms')return {rooms:[{uuid:ROOM,name:'WORLD::Gwen',note:'World',nomis:[{uuid:NOMI}]}]};
    if(path==='/rooms/'+ROOM && method==='GET')return {room:{uuid:ROOM,name:'WORLD::Gwen',note:'World'}};
    if(path==='/rooms/'+ROOM && method==='DELETE')return {};
    throw Error('Unexpected '+method+' '+path);
  };
  await assert.rejects(()=>h.driver.deleteRoom(ROOM,NOMI,'wrong name'));
  assert.equal(requests.some(p=>p.startsWith('DELETE ')),false);
  await h.storage.set({['nomiApiCheckpoint:'+ROOM]:{roomId:ROOM,status:'send_uncertain',confirmed:0,total:1}});
  await assert.rejects(()=>h.driver.deleteRoom(ROOM,NOMI,'WORLD::Gwen'));
  assert.equal(requests.some(p=>p.startsWith('DELETE ')),false);
  await h.storage.set({['nomiApiCheckpoint:'+ROOM]:{roomId:ROOM,status:'completed',confirmed:1,total:1}});
  const result=await h.driver.deleteRoom(ROOM,NOMI,'WORLD::Gwen');
  assert.equal(result.deleted,true);
  assert.ok(requests.some(p=>p==='DELETE /rooms/'+ROOM));
  assert.equal(await h.cp.load(ROOM),null);
});
test('deletion never retries an uncertain DELETE and never destroys checkpoint',async()=>{
  const h=harness('hello');
  h.stop();
  await h.storage.set({['nomiApiCheckpoint:'+ROOM]:{roomId:ROOM,status:'completed',confirmed:1,total:1}});
  let deletions=0;
  h.driver.request=async(path,method='GET')=>{
    if(path==='/nomis')return {nomis:[{uuid:NOMI,name:'Gwen'}]};
    if(path==='/rooms')return {rooms:[{uuid:ROOM,name:'World',nomis:[{uuid:NOMI}]}]};
    if(path==='/rooms/'+ROOM && method==='GET')return {room:{uuid:ROOM,name:'World',note:'World'}};
    if(path==='/rooms/'+ROOM && method==='DELETE'){deletions++;throw Error('504 uncertain');}
    throw Error('Unexpected '+method+' '+path);
  };
  await assert.rejects(()=>h.driver.deleteRoom(ROOM,NOMI,'World'));
  assert.equal(deletions,1);
  assert.equal((await h.cp.load(ROOM)).status,'completed');
});
test('room management is blocked while the bridge runs',async()=>{
  const h=harness('hello');
  await assert.rejects(()=>h.driver.updateRoomNote(ROOM,'new','old'));
  await assert.rejects(()=>h.driver.deleteRoom(ROOM,NOMI,'WORLD::Gwen'));
});
