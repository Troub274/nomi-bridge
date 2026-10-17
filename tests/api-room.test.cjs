const {test}=require('node:test');
const assert=require('node:assert/strict');
globalThis.crypto ||= require('node:crypto').webcrypto;
const {GroupBridge}=require('../extension/group.js');
const utils=require('../extension/api-room.js');
globalThis.NomiApiRoom=utils;
const {ApiRoomCheckpoint}=require('../extension/api-checkpoint.js');
globalThis.ApiRoomCheckpoint=ApiRoomCheckpoint;
const {WorldObserver,parseWorldCommand,completedLiveExchange}=require('../extension/world-observer.js');
globalThis.WorldObserver=WorldObserver;
globalThis.parseWorldCommand=parseWorldCommand;
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

test('live monitor waits for fresh conversation instead of replaying old history as Nomi reply',async()=>{
  const h=harness('[say room]\nYou are hungry and considering lunch.'),sent=[];
  const s=h.b.apiSession;s.monitorEnabled=true;s.monitorTabId='555';
  const url='https://nomi.ai/nomis/'+NOMI;
  await h.driver.observeLive('555',{site:'nomi',url,liveMessages:[
    {speaker:'User',text:'How is your morning?',key:'u1'},
    {speaker:'Nomi',text:'I am hungry.',key:'n1'}
  ]});
  let requested=0;
  h.driver.request=async(path,method,body)=>{
    if(path.endsWith('/chat')){sent.push(body.messageText);return {};}
    if(path.endsWith('/chat/request')){requested++;return {replyMessage:{messageText:'unexpected'}};}
    throw Error('Unexpected '+path);
  };
  await h.driver.pump();await h.settle();
  assert.equal(sent.join(''),'You are hungry and considering lunch.');
  assert.equal(requested,0);
  assert.equal(h.b.tabs[virtual].reply,'','old live history must not be presented as a new reply');
  let cp=await h.cp.load(ROOM);
  assert.equal(cp.status,'awaiting_reply');
  assert.equal(s.pendingReply,'live_wait');
  await h.driver.pump();await h.settle();
  assert.equal(h.b.tabs[virtual].reply,'','polling cannot manufacture a GPT turn');
  await h.driver.observeLive('555',{site:'nomi',url,liveMessages:[
    {speaker:'User',text:'How is your morning?',key:'u1'},
    {speaker:'Nomi',text:'I am hungry.',key:'n1'},
    {speaker:'Nomi',text:'I will make lunch now.',key:'n2'}
  ]});
  await h.driver.pump();await h.settle();
  assert.equal(requested,0,'fresh live observation must suppress room reply requests');
  assert.match(h.b.tabs[virtual].reply,/I will make lunch now/);
  cp=await h.cp.load(ROOM);
  assert.equal(cp.status,'reply_received');
  assert.equal(cp.sourceFullReply,h.reply);
  assert.equal(cp.text,'You are hungry and considering lunch.');
});

test('monitor falls back to API room reply if private chat lacks observed messages',async()=>{
  const h=harness('[say room]\nYou feel a cool breeze.');
  const s=h.b.apiSession;s.monitorEnabled=true;s.monitorTabId='555';
  await h.driver.observeLive('555',{site:'nomi',url:'https://nomi.ai/nomis/'+NOMI,liveMessages:[]});
  let replied=0;
  h.driver.request=async(path,method,body)=>{
    if(path.endsWith('/chat'))return {};
    if(path.endsWith('/chat/request')){replied++;return {replyMessage:{messageText:'I feel the breeze.'}};}
    throw Error('Unexpected '+path);
  };
  await h.driver.pump();await h.settle();
  assert.equal(replied,1);
  assert.equal(h.b.tabs[virtual].reply,'I feel the breeze.');
});

test('monitor command [tail] reads local journal without posting a new Nomi message',async()=>{
  const h=harness('[tail]'),s=h.b.apiSession;
  s.monitorEnabled=true;s.monitorTabId='555';
  await h.driver.observeLive('555',{site:'nomi',url:'https://nomi.ai/nomis/'+NOMI,liveMessages:[
    {speaker:'User',text:'Let’s have coffee.',key:'a'},
    {speaker:'Nomi',text:'Sounds lovely.',key:'b'}
  ]});
  let posts=0;
  h.driver.request=async()=>{posts++;throw Error('Should not call Nomi API on [tail]');};
  await h.driver.pump();await h.settle();
  assert.equal(posts,0);
  assert.match(h.b.tabs[virtual].reply,/Sounds lovely/);
  assert.equal((await h.driver.observer.history(ROOM)).length,2);
});

test('history pages preserve chronology across restart and suppress duplicate observations',async()=>{
  const h=harness('world init');
  const journal=h.driver.observer;
  for(let i=0;i<25;i++){
    await journal.observeLive(ROOM,'https://nomi.ai/nomis/'+NOMI,[
      {speaker:i%2?'Nomi':'User',text:'Message '+i+' '+('🍃'.repeat(300)),key:'msg-'+i}
    ]);
  }
  await journal.observeLive(ROOM,'https://nomi.ai/nomis/'+NOMI,[
    {speaker:'User',text:'Message 0 '+('🍃'.repeat(300)),key:'msg-0'}
  ]);
  const secondInstance=new WorldObserver(h.storage);
  const entries=await secondInstance.history(ROOM);
  assert.equal(entries.length,25);
  const p1=await secondInstance.historyPage(ROOM,1,2500);
  const p2=await secondInstance.historyPage(ROOM,2,2500);
  assert.ok(p1.pages>1);
  assert.ok(p1.events[0].seq>p2.events.at(-1).seq,'page 1 should be newer than page 2');
  assert.deepEqual(parseWorldCommand('[history 2]'),{kind:'history',page:2,text:''});
  assert.equal(parseWorldCommand('[say chat]\nhello').kind,'chat');
  assert.equal(parseWorldCommand('[say room]\nYou are thirsty.').text,'You are thirsty.');
});

test('open but idle private chat returns to room replies after inactivity threshold',async()=>{
  const h=harness('[say room]\nThe afternoon is getting cooler.');
  const s=h.b.apiSession;
  s.monitorEnabled=true;s.monitorTabId='555';s.monitorIdleSeconds=120;
  await h.driver.observeLive('555',{site:'nomi',url:'https://nomi.ai/nomis/'+NOMI,
    liveMessages:[{speaker:'User',text:'Morning',key:'a'},{speaker:'Nomi',text:'Good morning',key:'b'}]});
  s.monitorLastActivity=Date.now()-121000;
  assert.equal(h.driver.isLiveAvailable(s),false);
  let replies=0;
  h.driver.request=async(path)=>{
    if(path.endsWith('/chat'))return {};
    if(path.endsWith('/chat/request')){replies++;return {replyMessage:{messageText:'I notice the cool air.'}};}
    throw Error('unexpected API');
  };
  await h.driver.pump();await h.settle();
  assert.equal(replies,1);
});

test('regression: [wait] is silent when monitor is disabled; it is not posted to Nomi',async()=>{
  const h=harness('[wait]');
  h.b.apiSession.monitorEnabled=false;
  let requests=0;
  h.driver.request=async()=>{requests++;throw Error('Unexpected Nomi API request triggered by [wait]');};
  await h.driver.pump();await h.settle();
  assert.equal(requests,0);
  assert.equal(h.b.apiSession.pendingReply,'live_wait');
  assert.equal(h.b.running,true);
  assert.equal(h.b.command,null);
  assert.equal(h.b.tabs[virtual].reply,'');
  await h.driver.pump();await h.settle();
  assert.equal(requests,0,'idle pump cannot fabricate a room reply request');
  assert.equal(h.b.tabs[virtual].reply,'','idle pump cannot fabricate a GPT update');
});

test('regression: [wait] with monitor enabled but no live messages remains passive',async()=>{
  const h=harness('[wait]');
  h.b.apiSession.monitorEnabled=true;
  h.b.apiSession.monitorTabId='555';
  let requests=0;
  h.driver.request=async()=>{requests++;throw Error('Unexpected API request');};
  await h.driver.pump();await h.settle();
  assert.equal(h.b.apiSession.pendingReply,'live_wait');
  assert.equal(h.b.tabs[virtual].reply,'');
  h.b.apiSession.monitorSeen=0;h.b.apiSession.monitorCount=0;
  await h.driver.pump();await h.settle();
  assert.equal(requests,0);
  assert.equal(h.b.tabs[virtual].reply,'','no synthetic no-chat response may prompt GPT');
});

test('regression: [listening] without a new message never requests a new Nomi turn',async()=>{
  const h=harness('[listening]');
  h.b.apiSession.monitorEnabled=true;
  h.b.apiSession.monitorTabId='555';
  const previous=await h.driver.observer.observeLive(ROOM,'https://nomi.ai/nomis/'+NOMI,[
    {speaker:'Nomi',text:'I am having lunch.',key:'observed-1'}
  ]);
  h.b.apiSession.monitorLastSeq=previous.at(-1).seq;
  h.b.apiSession.monitorSeen=Date.now();h.b.apiSession.monitorCount=1;
  h.b.apiSession.monitorLastActivity=Date.now();
  let requests=0;
  h.driver.request=async()=>{requests++;throw Error('Unexpected API request');};
  await h.driver.pump();await h.settle();
  assert.equal(h.b.apiSession.pendingReply,'live_wait');
  assert.equal(h.b.tabs[virtual].reply,'');
  await h.driver.pump();await h.settle();
  assert.equal(requests,0);
  assert.equal(h.b.tabs[virtual].reply,'');
});

test('command parser never treats malformed control tags as Nomi world messages',()=>{
  for(const input of [
    '[tail] extra commentary','Here is my response:\n[tail]',
    '**[history]**', '- [listening]', '[wait]\nI am just thinking',
    '[history 2]\nThanks', '[say room]\nThe coffee is ready.\n[tail]',
    '[say chat]\nHi\n[wait]','[play]','[say]',
    '```text\n[tail]\nNot a valid batch\n```'
  ]){
    assert.equal(parseWorldCommand(input).kind,'invalid',input);
  }
  assert.equal(parseWorldCommand('```text\n[tail]\n```').kind,'tail');
  assert.equal(parseWorldCommand('```\n[history 3]\n```').page,3);
  assert.equal(parseWorldCommand('[say room]\nYou feel hungry.').kind,'room');
  assert.equal(parseWorldCommand('[say room] The sun is rising.').text,'The sun is rising.');
});

test('invalid [tail] or [history] command is consumed without any Nomi POST or checkpoint',async()=>{
  for(const reply of ['[tail] followed by commentary','Here is the status:\n[history]',
      '[say room]\nYou feel hungry\n[wait]']){
    const h=harness(reply);
    let calls=0;
    h.driver.request=async()=>{calls++;throw Error('Nomi API must never receive malformed control commands');};
    await h.driver.pump();await h.settle();
    assert.equal(calls,0,reply);
    assert.equal(await h.cp.load(ROOM),null,'no checkpoint should be created');
    assert.equal(h.b.running,true,'invalid tag must not poison API checkpoint recovery');
    assert.equal(h.b.phase,'reply');
    assert.equal(h.b.source,GPT_ID,'wait for a corrected GPT command');
    assert.equal(h.b.command,null);
    assert.match(h.b.reason,/protocol error/i);
  }
});

test('direct checkpoint send guard refuses control commands before any room HTTP request',async()=>{
  const h=harness('A world description.');
  let posts=0;
  h.driver.request=async()=>{posts++;throw Error('POST must not be executed');};
  const cp={roomId:ROOM,nomiUuid:NOMI,text:'[tail]',total:1,confirmed:0,attemptedIndex:null};
  await assert.rejects(()=>h.driver.sendChunks(cp));
  assert.equal(posts,0);
});

test('passive listen survives the old 15-minute inactivity stop',async()=>{
  const h=harness('[wait]');
  h.b.apiSession.monitorEnabled=false;
  h.driver.request=async()=>{throw Error('No API request expected');};
  await h.driver.pump();await h.settle();
  h.b.startedWait=h.b.clock()-1600;
  h.b.tick();
  assert.equal(h.b.running,true);
  assert.equal(h.b.apiSession.pendingReply,'live_wait');
});

test('a harmless ChatGPT reload in API mode retains session and ignores stale GPT reply',async()=>{
  const h=harness('[tail] unexpected commentary');
  h.driver.request=async()=>{throw Error('No Nomi request expected');};
  await h.driver.pump();await h.settle();
  const previous=h.b.tabs[GPT_ID],newSnapshot={
    ...previous,document:'new-doc-after-reload',replyKey:'reload-key'
  };
  h.b.heartbeat(GPT_ID,newSnapshot);
  assert.equal(h.b.running,true);
  assert.notEqual(h.b.phase,'uncertain');
  assert.equal(h.b.baseline,'reload-key');
  assert.equal(h.b.command,null);
});

test('inactive live monitor falls back to one reply for already sent world text',async()=>{
  const h=harness('[say room]\nThe rain has started.'),s=h.b.apiSession;
  s.monitorEnabled=true;s.monitorTabId='555';s.monitorIdleSeconds=300;
  const url='https://nomi.ai/nomis/'+NOMI;
  await h.driver.observeLive('555',{site:'nomi',url,liveMessages:[
    {speaker:'User',text:'Morning!',key:'u1'}]});
  let posts=0,replies=0;
  h.driver.request=async(path)=>{
    if(path.endsWith('/chat')){posts++;return {};}
    if(path.endsWith('/chat/request')){replies++;return {replyMessage:{messageText:'It is raining.'}};}
    throw Error('Unexpected '+path);
  };
  await h.driver.pump();await h.settle();
  assert.equal(posts,1);assert.equal(replies,0);
  assert.equal(s.pendingReply,'live_wait');
  s.monitorLastActivity=Date.now()-301000;
  await h.driver.pump();await h.settle();
  assert.equal(posts,1,'fallback never resends world message');
  assert.equal(replies,1,'fallback requests precisely one room reply');
  assert.equal(h.b.tabs[virtual].reply,'It is raining.');
});

test('recovering an awaiting world event resumes live monitoring without requesting an API reply',async()=>{
  const h=harness('[say room]\nYou are warm after walking.'),s=h.b.apiSession;
  s.monitorEnabled=true;s.monitorTabId='555';
  const url='https://nomi.ai/nomis/'+NOMI;
  await h.driver.observeLive('555',{site:'nomi',url,liveMessages:[
    {speaker:'User',text:'Hi Gwen',key:'u1'}
  ]});
  let roomSends=0,roomReplies=0;
  h.driver.request=async(path)=>{
    if(path.endsWith('/chat')){roomSends++;return {};}
    if(path.endsWith('/chat/request')){roomReplies++;return {replyMessage:{messageText:'Unwanted reply'}};}
    throw Error('unexpected '+path);
  };
  await h.driver.pump();await h.settle();
  assert.equal((await h.cp.load(ROOM)).status,'awaiting_reply');
  assert.equal(h.b.apiSession.pendingReply,'live_wait');
  h.b.stop();
  globalThis.chrome.tabs.sendMessage=async tabId=>Number(tabId)===555
    ?{snapshot:{site:'nomi',url,liveMessages:[
      {speaker:'User',text:'Hi Gwen',key:'u1'},
      {speaker:'Nomi',text:'I made myself lunch',key:'n2'}
    ]}}
    :{snapshot:{...h.source}};
  const result=await h.driver.recover(ROOM,'reply',{
    nomiUuid:NOMI,chatgptTab:GPT_ID,monitorLive:true,monitorTab:'555',monitorIdleSeconds:300
  });
  assert.equal(result.monitoring,true);
  assert.equal(h.b.apiSession.pendingReply,'live_wait');
  assert.equal(h.b.running,true);
  assert.equal(roomSends,1);
  assert.equal(roomReplies,0,'recovery must not request a second Nomi turn in active live monitor mode');
  await h.driver.pump();await h.settle();
  assert.equal(roomReplies,0);
});

test('passive [wait] can Stop and Play without creating a Nomi checkpoint',async()=>{
  const h=harness('[wait]');
  h.driver.request=async()=>{throw Error('No API request expected');};
  await h.driver.pump();await h.settle();
  assert.equal(await h.cp.load(ROOM),null);
  assert.equal(h.b.apiSession.pendingReply,'live_wait');
  h.b.stop();
  h.b.start({mode:'api-room',tabs:[GPT_ID,virtual],first:'first',settle:8});
  assert.equal(h.b.running,true);
  assert.equal(h.b.apiSession.pendingReply,'live_wait');
  assert.equal(h.b.command,null);
});

test('direct chat cannot accidentally forward World Engine control tags to Nomi',()=>{
  const b=new GroupBridge(()=>100);
  b.heartbeat('10',{site:'chatgpt',reply:'[tail]',replyKey:'q1',
    url:'https://chatgpt.com/c/test',document:'g',ready:true,complete:true,busy:false,draft:false,error:''});
  b.heartbeat('20',{site:'nomi',reply:'Hello',replyKey:'n1',
    url:'https://nomi.ai/nomis/nomi-test',document:'n',ready:true,complete:true,busy:false,draft:false,error:''});
  b.start({mode:'direct',tabs:['10','20'],first:'first',settle:3});
  b.tabs['10'].changed=0;b.tick();
  assert.equal(b.running,false);
  assert.equal(b.command,null);
  assert.match(b.reason,/control tag blocked/i);
});

test('catch-up returns ALL completed live messages since last listen; buffers trailing user',()=>{
  const entries=[
    {seq:101,channel:'live',speaker:'User',text:'First question'},
    {seq:102,channel:'live',speaker:'Nomi',text:'First answer'},
    {seq:103,channel:'live',speaker:'User',text:'Second question'},
    {seq:104,channel:'live',speaker:'Nomi',text:'Second answer'},
    {seq:105,channel:'live',speaker:'User',text:'Third question awaiting Nomi'}
  ];
  const round=completedLiveExchange(entries,100);
  assert.deepEqual(round.events.map(e=>e.seq),[101,102,103,104]);
  assert.equal(round.cursor,104);
  assert.equal(round.remaining,1);
  const single=completedLiveExchange(entries,104);
  assert.deepEqual(single.events,[]);
  const full=completedLiveExchange([...entries,{seq:106,channel:'live',speaker:'Nomi',text:'Third answer'}],104);
  assert.deepEqual(full.events.map(e=>e.seq),[105,106]);
});

test('catch-up only counts a User-to-Nomi round trip, never just a User or Nomi message',()=>{
  assert.equal(completedLiveExchange([{seq:2,channel:'live',speaker:'User',text:'Question'}],1).events.length,0);
  assert.equal(completedLiveExchange([{seq:2,channel:'live',speaker:'Nomi',text:'Unsolicited'}],1).events.length,0);
  assert.equal(completedLiveExchange([
    {seq:2,channel:'live',speaker:'Nomi',text:'Old'},
    {seq:3,channel:'live',speaker:'User',text:'New question'},
    {seq:4,channel:'live',speaker:'Nomi',text:'New answer'}],1).cursor,4);
});

test('catch-up pages at complete Nomi turns without discarding earlier messages',()=>{
  const entries=[];
  for(let i=1;i<=8;i++)entries.push({seq:i,channel:'live',speaker:i%2?'User':'Nomi',text:'x'.repeat(1500)});
  const first=completedLiveExchange(entries,0,7000);
  assert.deepEqual(first.events.map(e=>e.seq),[1,2,3,4]);
  assert.equal(first.truncated,true);
  const second=completedLiveExchange(entries,first.cursor,7000);
  assert.deepEqual(second.events.map(e=>e.seq),[5,6,7,8]);
  assert.equal(second.truncated,false);
});

test('monitor sends every completed exchange since last listen, advances cursor only on GPT ack',async()=>{
  const h=harness('[listening]'),s=h.b.apiSession;
  s.monitorEnabled=true;s.monitorTabId='555';s.monitorLastSeq=0;
  const url='https://nomi.ai/nomis/'+NOMI;
  const messages=[
    {speaker:'User',text:'Q one',key:'u1'},
    {speaker:'Nomi',text:'A one',key:'n1'},
    {speaker:'User',text:'Q two',key:'u2'},
    {speaker:'Nomi',text:'A two',key:'n2'},
    {speaker:'User',text:'Q three',key:'u3'}
  ];
  await h.driver.observeLive('555',{site:'nomi',url,liveMessages:messages});
  let posts=0;h.driver.request=async()=>{posts++;throw Error('Nomi must not be called for listening');};
  await h.driver.pump();await h.settle();
  const response=h.b.tabs[virtual].reply;
  assert.match(response,/Q one/);assert.match(response,/A one/);
  assert.match(response,/Q two/);assert.match(response,/A two/);
  assert.doesNotMatch(response,/Q three/,'unfinished user turn stays buffered');
  assert.equal(s.monitorLastSeq,0,'not committed until GPT confirms editor delivery');
  assert.equal(s.monitorPendingSeq,4);
  await h.driver.forwarded(ROOM);
  assert.equal(s.monitorLastSeq,4);
  assert.equal(s.monitorPendingSeq,0);
  assert.equal(posts,0);
});

test('non-destructive [tail] and [history] do not move the live-listening cursor',async()=>{
  for(const command of ['[tail]','[history]']){
    const h=harness(command),s=h.b.apiSession;
    s.monitorEnabled=true;s.monitorTabId='555';s.monitorLastSeq=0;
    await h.driver.observeLive('555',{site:'nomi',url:'https://nomi.ai/nomis/'+NOMI,
      liveMessages:[{speaker:'User',text:'How are you?',key:'u'},{speaker:'Nomi',text:'Good.',key:'n'}]});
    h.driver.request=async()=>{throw Error('No Nomi API POST expected');};
    await h.driver.pump();await h.settle();
    await h.driver.forwarded(ROOM);
    assert.equal(s.monitorLastSeq,0,command);
    assert.equal(s.monitorPendingSeq||0,0,command);
  }
});

test('world sends do not consume the listening backlog; one subsequent complete round trip forwards all intervening chat',async()=>{
  const h=harness('[say room]\nThe kitchen window is open.'),s=h.b.apiSession;
  s.monitorEnabled=true;s.monitorTabId='555';s.monitorLastSeq=0;
  const url='https://nomi.ai/nomis/'+NOMI;
  const old=[
    {speaker:'User',text:'Did you sleep well?',key:'u1'},
    {speaker:'Nomi',text:'Yes, thanks.',key:'n1'},
    {speaker:'User',text:'Are you hungry?',key:'u2'},
    {speaker:'Nomi',text:'I could eat.',key:'n2'}
  ];
  await h.driver.observeLive('555',{site:'nomi',url,liveMessages:old});
  let roomPosts=0,replyRequests=0;
  h.driver.request=async(path)=>{
    if(path.endsWith('/chat')){roomPosts++;return {};}
    if(path.endsWith('/chat/request')){replyRequests++;return {replyMessage:{messageText:'API reply'}};}
    throw Error('Unexpected '+path);
  };
  await h.driver.pump();await h.settle();
  assert.equal(roomPosts,1);
  assert.equal(replyRequests,0);
  assert.equal(s.monitorLastSeq,0,'room sends must never move last listen cursor');
  assert.equal(s.monitorWorldStartSeq,4);
  await h.driver.observeLive('555',{site:'nomi',url,liveMessages:[
    ...old,{speaker:'User',text:'Would you like lunch?',key:'u3'}
  ]});
  await h.driver.pump();await h.settle();
  assert.equal(h.b.tabs[virtual].reply,'','do not forward when waiting for a response');
  await h.driver.observeLive('555',{site:'nomi',url,liveMessages:[
    ...old,{speaker:'User',text:'Would you like lunch?',key:'u3'},
    {speaker:'Nomi',text:'Yes, please.',key:'n3'}
  ]});
  await h.driver.pump();await h.settle();
  assert.match(h.b.tabs[virtual].reply,/Did you sleep well/);
  assert.match(h.b.tabs[virtual].reply,/Are you hungry/);
  assert.match(h.b.tabs[virtual].reply,/Would you like lunch/);
  assert.match(h.b.tabs[virtual].reply,/Yes, please/);
  assert.equal(replyRequests,0);
  assert.equal(s.monitorLastSeq,0);
  assert.equal(s.monitorPendingSeq,6);
  await h.driver.forwarded(ROOM);
  assert.equal(s.monitorLastSeq,6);
});
