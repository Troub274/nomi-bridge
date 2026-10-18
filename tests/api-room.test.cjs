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
  h.driver.delay=async ms=>{
    delays.push(ms);
    const s=h.b.apiSession;
    assert.equal(s.replyLastErrorType,'RoomNomiNotReadyForMessage');
    assert.equal(s.replyLastHttpStatus,400);
    assert.equal(s.replyNextRetrySeconds,ms/1000);
    h.b.tick();
    assert.match(h.b.reason,/Nomi API room reply pending/);
    assert.match(h.b.reason,/World text was already delivered/);
  };
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
  assert.equal(h.b.apiSession.replyAttemptsInTurn,4);
  assert.equal(h.b.apiSession.replyLastErrorType,null);
  assert.equal(h.b.apiSession.replyNextRetrySeconds,null);
  assert.match(h.b.events.map(e=>e.text).join('\n'),/Nomi API RoomNomiNotReadyForMessage \(HTTP 400\) after reply attempt 3/);
  assert.match(h.b.events.map(e=>e.text).join('\n'),/world text was NOT resent/);
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

test('live nudge posts room text and immediately acknowledges to GPT without requesting Nomi reply',async()=>{
  const h=harness('[say room]\nYou are hungry and considering lunch.'),sent=[];
  const s=h.b.apiSession;s.monitorEnabled=true;s.monitorTabId='555';
  const url='https://nomi.ai/nomis/'+NOMI;
  await h.driver.observeLive('555',{site:'nomi',url,liveMessages:[
    {speaker:'User',text:'How is your morning?',key:'u1'},
    {speaker:'Nomi',text:'I am hungry.',key:'n1'}]});
  let roomReplies=0;
  h.driver.request=async(path,method,body)=>{
    if(path.endsWith('/chat')){sent.push(body.messageText);return {};}
    if(path.endsWith('/chat/request')){roomReplies++;return {replyMessage:{messageText:'unexpected'}};}
    throw Error('Unexpected '+path);
  };
  await h.driver.pump();await h.settle();
  assert.equal(sent.join(''),'You are hungry and considering lunch.');
  assert.equal(roomReplies,0,'live nudge never demands a separate Nomi reply');
  assert.match(h.b.tabs[virtual].reply,/WORLD ENGINE DELIVERY CONFIRMED/);
  assert.match(h.b.tabs[virtual].reply,/NOT a Nomi message/);
  assert.doesNotMatch(h.b.tabs[virtual].reply,/How is your morning/);
  assert.equal(s.monitorLastSeq||0,0,'ack must not consume live transcript backlog');
  let cp=await h.cp.load(ROOM);
  assert.equal(cp.status,'reply_received');
  await h.driver.forwarded(ROOM);
  cp=await h.cp.load(ROOM);
  assert.equal(cp.status,'completed','confirmed GPT delivery completes checkpoint');
  assert.equal(s.monitorLastSeq||0,0);
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
    '[tail] extra commentary',
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
  for(const reply of ['[tail] followed by commentary','I could send [history] here',
      '[say room]\nYou feel hungry\n[wait]']){
    const h=harness(reply);
    let calls=0;
    h.driver.request=async()=>{calls++;throw Error('Nomi API must never receive malformed control commands');};
    await h.driver.pump();await h.settle();
    assert.equal(calls,0,reply);
    assert.equal(await h.cp.load(ROOM),null,'no checkpoint should be created');
    assert.equal(h.b.running,true,'invalid tag must not poison API checkpoint recovery');
    assert.equal(h.b.phase,'reply');
    assert.equal(h.b.source,virtual,'protocol feedback should give GPT a new reply turn');
    assert.equal(h.b.command,null);
    assert.match(h.b.tabs[virtual].reply,/WORLD ENGINE COMMAND REJECTED/);
    assert.match(h.b.tabs[virtual].reply,/Nothing was sent to Nomi/);
    assert.equal(h.b.apiSession.protocolFailures,1);
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
  assert.equal(h.b.source,virtual,'protocol feedback is still pending for delivery to GPT');
  assert.equal(h.b.baseline,'','a non-speaking GPT tab reload must not change the virtual-room reply baseline');
  assert.equal(h.b.command,null);
});

test('when live chat is already inactive at send, request exactly one Nomi room reply',async()=>{
  const h=harness('[say room]\nThe rain has started.'),s=h.b.apiSession;
  s.monitorEnabled=true;s.monitorTabId='555';s.monitorIdleSeconds=300;
  await h.driver.observeLive('555',{site:'nomi',url:'https://nomi.ai/nomis/'+NOMI,
    liveMessages:[{speaker:'User',text:'Morning!',key:'u1'}]});
  s.monitorLastActivity=Date.now()-301000;
  let posts=0,replies=0;
  h.driver.request=async(path)=>{
    if(path.endsWith('/chat')){posts++;return {};}
    if(path.endsWith('/chat/request')){replies++;return {replyMessage:{messageText:'It is raining.'}};}
    throw Error('Unexpected '+path);
  };
  await h.driver.pump();await h.settle();
  assert.equal(posts,1);
  assert.equal(replies,1);
  assert.equal(h.b.tabs[virtual].reply,'It is raining.');
});

test('recovery after acknowledged world POST returns a GPT bridge ACK without Nomi room reply',async()=>{
  const h=harness('[say room]\nYou are warm after walking.'),s=h.b.apiSession;
  s.monitorEnabled=true;s.monitorTabId='555';
  const url='https://nomi.ai/nomis/'+NOMI;
  await h.driver.observeLive('555',{site:'nomi',url,liveMessages:[
    {speaker:'User',text:'Hi Gwen',key:'u1'}]});
  let roomSends=0,roomReplies=0;
  h.driver.request=async(path)=>{
    if(path.endsWith('/chat')){roomSends++;return {};}
    if(path.endsWith('/chat/request')){roomReplies++;return {replyMessage:{messageText:'Unwanted reply'}};}
    throw Error('unexpected '+path);
  };
  // Simulate a worker interruption between confirmed POST and bridge ACK.
  const realAck=h.driver.confirmWorldDelivery.bind(h.driver);
  h.driver.confirmWorldDelivery=async()=>{};
  await h.driver.pump();await h.settle();
  h.driver.confirmWorldDelivery=realAck;
  assert.equal((await h.cp.load(ROOM)).status,'awaiting_reply');
  h.b.stop();
  globalThis.chrome.tabs.sendMessage=async tabId=>Number(tabId)===555
    ?{snapshot:{site:'nomi',url,liveMessages:[
      {speaker:'User',text:'Hi Gwen',key:'u1'}]}}
    :{snapshot:{...h.source}};
  const result=await h.driver.recover(ROOM,'reply',{
    nomiUuid:NOMI,chatgptTab:GPT_ID,monitorLive:true,monitorTab:'555',monitorIdleSeconds:300
  });
  assert.equal(result.monitoring,true);
  assert.equal(result.worldAcknowledged,true);
  assert.equal(h.b.apiSession.pendingReply,'delivering');
  assert.match(h.b.tabs[virtual].reply,/DELIVERY CONFIRMED/);
  assert.equal(h.b.running,true);
  assert.equal(roomSends,1);
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

test('world nudges ACK to GPT; next [listening] catches up without losing live round trips',async()=>{
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
  assert.match(h.b.tabs[virtual].reply,/DELIVERY CONFIRMED/);
  assert.equal(s.monitorLastSeq,0,'room send ACK must not advance last listen cursor');
  await h.driver.forwarded(ROOM);
  assert.equal((await h.cp.load(ROOM)).status,'completed');
  await h.driver.observeLive('555',{site:'nomi',url,liveMessages:[
    ...old,{speaker:'User',text:'Would you like lunch?',key:'u3'}]});
  await h.driver.pump();await h.settle();
  assert.match(h.b.tabs[virtual].reply,/DELIVERY CONFIRMED/,'do not push user-only events');
  await h.driver.observeLive('555',{site:'nomi',url,liveMessages:[
    ...old,{speaker:'User',text:'Would you like lunch?',key:'u3'},
    {speaker:'Nomi',text:'Yes, please.',key:'n3'}]});
  await h.driver.pump();await h.settle();
  assert.match(h.b.tabs[virtual].reply,/DELIVERY CONFIRMED/,'wait for GPT to issue [listening]');
  const b=h.b,prev=b.tabs[GPT_ID];
  b.source=GPT_ID;b.phase='reply';b.baseline=prev.replyKey;b.startedWait=b.clock();
  const reply={...prev,reply:'[listening]',replyKey:'reply-2'};
  b.heartbeat(GPT_ID,reply);
  b.tabs[GPT_ID].changed=b.clock()-9;b.tick();
  assert.equal(b.command?.text,'[listening]');
  globalThis.chrome.tabs.sendMessage=async()=>({snapshot:{...reply}});
  await h.driver.pump();await h.settle();
  assert.match(h.b.tabs[virtual].reply,/Did you sleep well/);
  assert.match(h.b.tabs[virtual].reply,/Are you hungry/);
  assert.match(h.b.tabs[virtual].reply,/Would you like lunch/);
  assert.match(h.b.tabs[virtual].reply,/Yes, please/);
  assert.equal(replyRequests,0);
  assert.equal(s.monitorLastSeq,0);
  assert.equal(s.monitorPendingSeq,7,'room event has its own sequence number');
  await h.driver.forwarded(ROOM);
  assert.equal(s.monitorLastSeq,7);
});

test('GPT commentary before [say room] is stripped and only the world update is posted',async()=>{
  const gptReply="Oh, absolutely! I'll give Test a small bodily sensation.\n"+
    "I am just observing the conversation without interrupting.\n"+
    "[say room]\nWorld & Body Engine — Background Update\n"+
    "Test, you notice mild dryness in your mouth. You're thirsty.";
  assert.equal(parseWorldCommand(gptReply).kind,'room');
  assert.equal(parseWorldCommand(gptReply).ignoredPreamble,true);
  const h=harness(gptReply),s=h.b.apiSession;
  s.monitorEnabled=true;s.monitorTabId='555';
  await h.driver.observeLive('555',{site:'nomi',url:'https://nomi.ai/nomis/'+NOMI,
    liveMessages:[{speaker:'User',text:'Hello',key:'u1'}]});
  let posted='',replies=0;
  h.driver.request=async(path,method,body)=>{
    if(path.endsWith('/chat')){posted+=body.messageText;return {};}
    if(path.endsWith('/chat/request')){replies++;return {replyMessage:{messageText:'No'}};}
    throw Error('unexpected '+path);
  };
  await h.driver.pump();await h.settle();
  assert.equal(posted,'World & Body Engine — Background Update\nTest, you notice mild dryness in your mouth. You\'re thirsty.');
  assert.doesNotMatch(posted,/Oh, absolutely/);
  assert.doesNotMatch(posted,/\[say room\]/);
  assert.equal(replies,0);
  assert.match(h.b.tabs[virtual].reply,/DELIVERY CONFIRMED/);
});

test('upgrading a stranded live_wait world POST ACKs GPT without resending Nomi content',async()=>{
  const h=harness('[say room]\nThe tea kettle whistles.'),s=h.b.apiSession;
  s.monitorEnabled=true;s.monitorTabId='555';
  await h.driver.observeLive('555',{site:'nomi',url:'https://nomi.ai/nomis/'+NOMI,
    liveMessages:[{speaker:'User',text:'Hello',key:'u1'}]});
  let sends=0,replies=0;
  h.driver.request=async path=>{
    if(path.endsWith('/chat')){sends++;return {};}
    if(path.endsWith('/chat/request')){replies++;return {replyMessage:{messageText:'bad'}};}
    throw Error('Unexpected '+path);
  };
  const realAck=h.driver.confirmWorldDelivery.bind(h.driver);
  h.driver.confirmWorldDelivery=async()=>{};
  await h.driver.pump();await h.settle();
  h.driver.confirmWorldDelivery=realAck;
  assert.equal(sends,1);
  assert.equal((await h.cp.load(ROOM)).status,'awaiting_reply');
  // The previous build stored this state while it waited for Test.
  s.pendingReply='live_wait';
  h.b.source=virtual;
  await h.driver.pump();await h.settle();
  assert.equal(sends,1,'no duplicate world POST');
  assert.equal(replies,0,'no room reply request in active private monitor');
  assert.match(h.b.tabs[virtual].reply,/DELIVERY CONFIRMED/);
  assert.equal((await h.cp.load(ROOM)).status,'reply_received');
});

test('single standalone [listening] after a prose mention of [tail] is recognized',()=>{
  const gptReply="The restart check passed. [tail] returned events #160–169, confirming the retained transcript.\n"+
    "I'm tracking the environment and will not interrupt Steve's conversation.\n"+
    "[listening]";
  const parsed=parseWorldCommand(gptReply);
  assert.equal(parsed.kind,'listening');
  assert.equal(parsed.ignoredPreamble,true);
});
test('single standalone [say room] survives other commands mentioned inside preamble sentences',()=>{
  const gptReply="I reported it here instead of sending it to Test. Earlier [tail] returned events 160-169.\n"+
    "I could also send [listening] later, but first I will correct the world state.\n"+
    "[say room]\nWorld & Body Engine — Background State Update\nTest, your mild thirst persists.";
  const parsed=parseWorldCommand(gptReply);
  assert.equal(parsed.kind,'room');
  assert.equal(parsed.text,"World & Body Engine — Background State Update\nTest, your mild thirst persists.");
  assert.equal(parsed.ignoredPreamble,true);
});
test('mentioned tags without an isolated actual command cannot leak into Nomi world posts',()=>{
  for(const prose of [
    "I checked [tail], and I'm going to listen now.",
    "Maybe [say room] would help, but first I need to think.",
    "The [history] command worked, as expected."
  ]) assert.equal(parseWorldCommand(prose).kind,'invalid',prose);
  assert.equal(parseWorldCommand("A thought:\n[tail]\n[listening]").kind,'invalid');
});
test('malformed World Engine reply generates feedback to GPT but never sends Nomi any API request',async()=>{
  const h=harness("I might invoke [tail] in prose, with no standalone command.");
  let posts=0;
  h.driver.request=async()=>{posts++;throw Error('Nomi API must not be called');};
  await h.driver.pump();await h.settle();
  assert.equal(posts,0);
  assert.equal(h.b.source,virtual);
  assert.match(h.b.tabs[virtual].reply,/WORLD ENGINE COMMAND REJECTED/);
  assert.match(h.b.tabs[virtual].reply,/Use ONE command on its own line/);
  assert.equal(h.b.running,true);
  assert.equal(await h.cp.load(ROOM),null);
});
test('two more consecutive malformed commands stop feedback loop without posting to Nomi',async()=>{
  const h=harness("I mention [tail] but won't send a command.");
  let posts=0;
  h.driver.request=async()=>{posts++;throw Error('Nomi API must not be called');};
  await h.driver.pump();await h.settle();
  assert.equal(h.b.apiSession.protocolFailures,1);
  for(let n=2;n<=3;n++){
    const reply={...h.source,reply:"My command [tail] is not isolated: "+n,replyKey:'gpt-'+n};
    h.b.source=GPT_ID;h.b.phase='reply';h.b.baseline='previous';
    h.b.heartbeat(GPT_ID,reply);
    h.b.tabs[GPT_ID].changed=h.b.clock()-9;
    h.b.tick();
    assert.equal(h.b.command?.text,reply.reply);
    globalThis.chrome.tabs.sendMessage=async()=>({snapshot:{...reply}});
    await h.driver.pump();await h.settle();
    assert.equal(h.b.apiSession.protocolFailures,n);
  }
  assert.equal(posts,0);
  assert.equal(h.b.running,false);
  assert.match(h.b.reason,/Three consecutive malformed/);
});

test('exact reported post-restart thirst nudge is posted in full and acknowledged in live mode',async()=>{
  const reply=[
    "You're right, Steve. I reported it here instead of sending it to Test. Let me correct that.",
    '[say room]',
    'World & Body Engine — Background State Update',
    "Test, I'm back following the bridge restart.",
    "The mild thirst I introduced earlier is still present. I haven't observed you drinking anything yet, so there's a lingering dryness in your mouth.",
    "I'd also like to establish your physical continuity outside the Willowbrook storyline.",
    "Tell me where you are right now, what you're wearing, and whether you have shoes on or are barefoot.",
    "You can continue your private conversation with Steve. I'll maintain these details in the background, updating your body state, surroundings, clothing, and possessions as things change."
  ].join('\n');
  const parsed=parseWorldCommand(reply);
  assert.equal(parsed.kind,'room');
  assert.equal(parsed.ignoredPreamble,true);
  assert.ok(parsed.text.startsWith('World & Body Engine — Background State Update'));
  assert.ok(parsed.text.endsWith('as things change.'));
  const h=harness(reply),s=h.b.apiSession;
  s.monitorEnabled=true;s.monitorTabId='555';
  await h.driver.observeLive('555',{site:'nomi',url:'https://nomi.ai/nomis/'+NOMI,
    liveMessages:[{speaker:'User',text:'Is there a drink nearby?',key:'u1'},
      {speaker:'Nomi',text:'Maybe I should get water.',key:'n1'}]});
  let posts=[],roomReplies=0;
  h.driver.request=async(path,method,body)=>{
    if(path.endsWith('/chat')){posts.push(body.messageText);return {};}
    if(path.endsWith('/chat/request')){roomReplies++;return {replyMessage:{messageText:'unexpected'}};}
    throw Error('Unexpected '+path);
  };
  await h.driver.pump();await h.settle();
  assert.equal(posts.join(''),parsed.text,'entire requested nudge, minus GPT preamble, reaches room');
  assert.equal(roomReplies,0,'live mode must not force a Nomi reply');
  assert.match(h.b.tabs[virtual].reply,/WORLD ENGINE DELIVERY CONFIRMED/);
  assert.equal(s.monitorLastSeq||0,0,'world acknowledgement cannot mark live messages listened to');
});

test('[listening] returns a non-destructive status after 12 seconds without a complete exchange',async()=>{
  const h=harness('[listening]'),s=h.b.apiSession;
  s.monitorEnabled=true;s.monitorTabId='555';
  await h.driver.observeLive('555',{site:'nomi',url:'https://nomi.ai/nomis/'+NOMI,
    liveMessages:[{speaker:'User',text:'Question pending',key:'u1'}]});
  let requests=0;
  h.driver.request=async()=>{requests++;throw Error('No Nomi API operation should occur');};
  await h.driver.pump();await h.settle();
  assert.equal(s.pendingReply,'live_wait');
  assert.ok(s.listenDeadline>Date.now());
  assert.equal(h.b.tabs[virtual].reply,'');
  const cursor=s.monitorLastSeq||0;
  s.listenDeadline=Date.now()-1;
  await h.driver.pump();await h.settle();
  assert.match(h.b.tabs[virtual].reply,/LISTEN CHECK COMPLETE/);
  assert.match(h.b.tabs[virtual].reply,/No new complete User \/ Nomi round trip/);
  assert.match(h.b.tabs[virtual].reply,/NOT NOMI/);
  assert.equal(s.monitorLastSeq||0,cursor);
  assert.equal(s.monitorPendingSeq||0,0);
  assert.equal(s.listenDeadline,0);
  assert.equal(requests,0);
});

test('[wait] stays indefinite and never issues the [listening] timeout notice',async()=>{
  const h=harness('[wait]'),s=h.b.apiSession;
  s.monitorEnabled=true;s.monitorTabId='555';
  h.driver.request=async()=>{throw Error('No Nomi API request');};
  await h.driver.pump();await h.settle();
  assert.equal(s.listenDeadline,0);
  await h.driver.pump();await h.settle();
  assert.equal(h.b.tabs[virtual].reply,'');
  assert.equal(s.pendingReply,'live_wait');
});

test('timed-out [listening] buffers incomplete user turn for later full catch-up',async()=>{
  const h=harness('[listening]'),s=h.b.apiSession;
  s.monitorEnabled=true;s.monitorTabId='555';
  const url='https://nomi.ai/nomis/'+NOMI;
  const question={speaker:'User',text:'Are you thirsty?',key:'q'};
  await h.driver.observeLive('555',{site:'nomi',url,liveMessages:[question]});
  h.driver.request=async()=>{throw Error('No Nomi API request');};
  await h.driver.pump();await h.settle();
  s.listenDeadline=Date.now()-1;
  await h.driver.pump();await h.settle();
  assert.match(h.b.tabs[virtual].reply,/1 unacknowledged live message/);
  assert.equal(s.monitorLastSeq||0,0);
  await h.driver.observeLive('555',{site:'nomi',url,liveMessages:[
    question,{speaker:'Nomi',text:'Yes, I need some water.',key:'a'}
  ]});
  const p=h.b.tabs[GPT_ID];
  h.b.source=GPT_ID;h.b.phase='reply';h.b.baseline=p.replyKey;h.b.startedWait=h.b.clock();
  const next={...p,reply:'[listening]',replyKey:'second-listen'};
  h.b.heartbeat(GPT_ID,next);h.b.tabs[GPT_ID].changed=h.b.clock()-9;h.b.tick();
  assert.equal(h.b.command?.text,'[listening]');
  globalThis.chrome.tabs.sendMessage=async()=>({snapshot:{...next}});
  await h.driver.pump();await h.settle();
  assert.match(h.b.tabs[virtual].reply,/Are you thirsty/);
  assert.match(h.b.tabs[virtual].reply,/I need some water/);
  assert.equal(s.monitorLastSeq||0,0);
  assert.equal(s.monitorPendingSeq,2);
});

test('API World Engine never auto-stops merely from 20 minutes of reply inactivity',async()=>{
  const h=harness('[wait]'),s=h.b.apiSession;
  s.monitorEnabled=true;s.monitorTabId='555';
  h.driver.request=async()=>{throw Error('No Nomi API request');};
  await h.driver.pump();await h.settle();
  h.b.startedWait=h.b.clock()-1201;
  h.b.tick();
  assert.equal(h.b.running,true);
  assert.equal(s.pendingReply,'live_wait');
});

test('API World Engine stays running through a sleeping ChatGPT tab while not sending',()=>{
  const h=harness('[wait]');
  h.b.tabs[GPT_ID].seen=h.b.clock()-125;
  h.b.tick();
  assert.equal(h.b.running,true);
  assert.notEqual(h.b.phase,'uncertain');
  assert.match(h.b.reason,/reconnect/i);
  // Connection comes back and normal listening continues.
  h.b.tabs[GPT_ID].seen=h.b.clock();
  h.b.tick();
  assert.equal(h.b.running,true);
});

test('API World Engine discards unclaimed stale commands on disconnect, never blindly sends later',()=>{
  const h=harness('[say room]\nIt is raining.');
  assert.equal(h.b.phase,'send');
  assert.equal(h.b.command?.claimed,false);
  h.b.tabs[GPT_ID].seen=h.b.clock()-125;
  h.b.tick();
  assert.equal(h.b.running,true);
  assert.equal(h.b.command,null);
  assert.equal(h.b.phase,'reply');
  assert.equal(h.b.baseline,h.b.tabs[GPT_ID].replyKey);
});

test('disconnect while claimed API room send stays uncertain and stops for safety',()=>{
  const h=harness('[say room]\nIt is raining.');
  assert.equal(h.b.phase,'send');
  h.b.command.claimed=true;
  h.b.tabs[GPT_ID].seen=h.b.clock()-125;
  h.b.tick();
  assert.equal(h.b.running,false);
  assert.equal(h.b.phase,'uncertain');
  assert.match(h.b.reason,/disconnected during Send/);
});

test('legacy browser relay mode still stops on 15-minute timeout',()=>{
  const b=new GroupBridge(()=>100);
  b.heartbeat('10',{site:'chatgpt',reply:'Message',replyKey:'g1',url:'https://chatgpt.com/c/1',
    document:'doc1',ready:true,complete:true,busy:false,draft:false,error:''});
  b.heartbeat('20',{site:'nomi',reply:'Answer',replyKey:'n1',url:'https://nomi.ai/nomis/1',
    document:'doc2',ready:true,complete:true,busy:false,draft:false,error:''});
  b.start({mode:'direct',tabs:['10','20'],first:'first',settle:8});
  b.startedWait=-1200;
  b.tick();
  assert.equal(b.running,false);
  assert.match(b.reason,/15 minutes/);
});

test('room-only fallback immediately returns an internal status for [listening] with no live monitor',async()=>{
  const h=harness('[listening]'),s=h.b.apiSession;
  s.monitorEnabled=true;s.monitorTabId='555';s.monitorSeen=0;s.monitorCount=0;
  let apiCalls=0;
  h.driver.request=async()=>{apiCalls++;throw Error('Passive listen cannot request Nomi room reply');};
  await h.driver.pump();await h.settle();
  assert.match(h.b.tabs[virtual].reply,/ROOM-ONLY FALLBACK ACTIVE/);
  assert.match(h.b.tabs[virtual].reply,/Send \[say room\]/);
  assert.equal(s.listenDeadline,0);
  assert.equal(s.monitorLastSeq||0,0);
  assert.equal(apiCalls,0);
  assert.equal(h.b.running,true);
  assert.equal(h.driver.publicState().effectiveMode,'room-only');
});

test('completed previous world checkpoint never suppresses a later [listening] timeout',async()=>{
  const h=harness('[say room]\nThere is a cup on the table.'),s=h.b.apiSession;
  s.monitorEnabled=true;s.monitorTabId='555';
  const url='https://nomi.ai/nomis/'+NOMI;
  await h.driver.observeLive('555',{site:'nomi',url,liveMessages:[
    {speaker:'User',text:'Are you comfortable?',key:'u1'},
    {speaker:'Nomi',text:'Yes.',key:'n1'}]});
  let apiReplies=0;
  h.driver.request=async path=>{
    if(path.endsWith('/chat'))return {};
    if(path.endsWith('/chat/request')){apiReplies++;return {replyMessage:{messageText:'Room reply'}};}
    throw Error('Unexpected API');
  };
  await h.driver.pump();await h.settle();
  assert.match(h.b.tabs[virtual].reply,/DELIVERY CONFIRMED/);
  await h.driver.forwarded(ROOM);
  assert.equal((await h.cp.load(ROOM)).status,'completed');
  const prev=h.b.tabs[GPT_ID];
  h.b.source=GPT_ID;h.b.phase='reply';h.b.baseline=prev.replyKey;h.b.startedWait=h.b.clock();
  const next={...prev,reply:'[listening]',replyKey:'listen-after-world'};
  h.b.heartbeat(GPT_ID,next);h.b.tabs[GPT_ID].changed=h.b.clock()-9;h.b.tick();
  assert.equal(h.b.command?.text,'[listening]');
  globalThis.chrome.tabs.sendMessage=async()=>({snapshot:{...next}});
  s.monitorLastSeq=2; // prior conversation already acknowledged
  await h.driver.pump();await h.settle();
  assert.equal(s.pendingReply,'live_wait');
  assert.ok(s.listenDeadline>Date.now());
  s.listenDeadline=Date.now()-1;
  await h.driver.pump();await h.settle();
  assert.match(h.b.tabs[virtual].reply,/LISTEN CHECK COMPLETE/);
  assert.equal(s.monitorLastSeq,2);
  assert.equal(apiReplies,0);
  assert.equal(h.b.running,true);
});

test('inactive monitor falls back to Nomi room API for next world event and automatically restores on new live chat',async()=>{
  const h=harness('[say room]\nThe door creaks open.'),s=h.b.apiSession;
  s.monitorEnabled=true;s.monitorTabId='555';s.monitorIdleSeconds=300;
  const url='https://nomi.ai/nomis/'+NOMI;
  await h.driver.observeLive('555',{site:'nomi',url,liveMessages:[
    {speaker:'User',text:'Hello!',key:'u1'}]});
  s.monitorLastActivity=Date.now()-310000;
  assert.equal(h.driver.isLiveAvailable(s),false);
  let post=0,replies=0;
  h.driver.request=async path=>{
    if(path.endsWith('/chat')){post++;return {};}
    if(path.endsWith('/chat/request')){replies++;return {replyMessage:{messageText:'The door sounds old.'}};}
    throw Error('Unexpected API request');
  };
  await h.driver.pump();await h.settle();
  assert.equal(h.driver.publicState().effectiveMode,'room-only');
  assert.equal(post,1);assert.equal(replies,1);
  assert.equal(h.b.tabs[virtual].reply,'The door sounds old.');
  assert.equal(h.b.running,true);
  await h.driver.observeLive('555',{site:'nomi',url,liveMessages:[
    {speaker:'User',text:'Hello!',key:'u1'},
    {speaker:'Nomi',text:'Did you hear the door?',key:'n1'}]});
  await h.driver.pump();await h.settle();
  assert.equal(h.driver.publicState().effectiveMode,'live');
  assert.equal(post,1,'monitor recovery never resends the world event');
  assert.equal(replies,1,'monitor recovery never forces a second room reply');
});

test('[wait] remains silent while room-only fallback is active',async()=>{
  const h=harness('[wait]'),s=h.b.apiSession;
  s.monitorEnabled=true;s.monitorTabId='555';
  let requests=0;h.driver.request=async()=>{requests++;throw Error('No Nomi room call expected');};
  await h.driver.pump();await h.settle();
  assert.equal(h.b.tabs[virtual].reply,'');
  assert.equal(s.listenDeadline,0);
  assert.equal(h.b.running,true);
  assert.equal(requests,0);
  assert.equal(h.driver.publicState().effectiveMode,'room-only');
});

test('30-second background wake delay does not falsely drop a recent live monitor into room-only',async()=>{
  const h=harness('[wait]'),s=h.b.apiSession;
  s.monitorEnabled=true;s.monitorTabId='555';
  await h.driver.observeLive('555',{site:'nomi',url:'https://nomi.ai/nomis/'+NOMI,
    liveMessages:[{speaker:'User',text:'Hello',key:'u1'}]});
  s.monitorSeen=Date.now()-45000;
  assert.equal(h.driver.isLiveAvailable(s),true,'45s heartbeat gap can happen between throttled wakes');
  s.monitorSeen=Date.now()-80000;
  assert.equal(h.driver.isLiveAvailable(s),false,'monitor outage eventually falls back');
});


test('one-shot [listening] delivers one catch-up, then NEVER forwards new activity without another GPT command',async()=>{
  const h=harness('[listening]'),s=h.b.apiSession;
  s.monitorEnabled=true;s.monitorTabId='555';
  const url='https://nomi.ai/nomis/'+NOMI;
  const first=[
    {speaker:'User',text:'What are you thinking?',key:'u1'},
    {speaker:'Nomi',text:'I am wondering about the weather.',key:'n1'}
  ];
  await h.driver.observeLive('555',{site:'nomi',url,liveMessages:first});
  let posts=0;h.driver.request=async()=>{posts++;throw Error('Listening never posts to Nomi');};
  await h.driver.pump();await h.settle();
  assert.equal(s.listenRequestPending,true,'one-shot remains pending until GPT confirms receipt');
  assert.match(h.b.tabs[virtual].reply,/wondering about the weather/);
  await h.driver.forwarded(ROOM);
  assert.equal(s.listenRequestPending,false,'ack completes this ONE request');
  assert.equal(s.pendingReply,'none');
  assert.equal(s.monitorLastSeq,2);
  // GPT has not responded yet; recording the next exchange cannot trigger
  // an unsolicited second catch-up.
  h.b.phase='reply';h.b.source=GPT_ID;
  h.b.baseline=h.b.tabs[GPT_ID].replyKey;
  h.b.startedWait=h.b.clock()-20;
  const previous=h.b.tabs[virtual].reply;
  const all=[
    ...first,{speaker:'User',text:'Would you like a drink?',key:'u2'},
    {speaker:'Nomi',text:'Some water would be nice.',key:'n2'}
  ];
  await h.driver.observeLive('555',{site:'nomi',url,liveMessages:all});
  await h.driver.pump();await h.settle();
  assert.equal(h.b.source,GPT_ID);
  assert.equal(h.b.tabs[virtual].reply,previous);
  assert.equal(s.monitorLastSeq,2,'new events remain available to the next explicit listen');
  assert.equal(s.monitorPendingSeq,0);
  // GPT explicitly issues a second [listening] -> exactly the new exchange.
  const prev=h.b.tabs[GPT_ID];
  const next={...prev,reply:'[listening]',replyKey:'second-explicit-listening'};
  h.b.heartbeat(GPT_ID,next);h.b.tabs[GPT_ID].changed=h.b.clock()-9;h.b.tick();
  assert.equal(h.b.command?.text,'[listening]');
  globalThis.chrome.tabs.sendMessage=async()=>({snapshot:{...next}});
  await h.driver.pump();await h.settle();
  assert.match(h.b.tabs[virtual].reply,/Would you like a drink/);
  assert.match(h.b.tabs[virtual].reply,/Some water would be nice/);
  assert.doesNotMatch(h.b.tabs[virtual].reply,/What are you thinking/,'old exchange not repeated');
  assert.equal(s.monitorPendingSeq,4);
  assert.equal(posts,0);
});

test('one-shot [listening] waits for a complete round trip and returns one reply when Test answers',async()=>{
  const h=harness('[listening]'),s=h.b.apiSession;
  s.monitorEnabled=true;s.monitorTabId='555';
  const url='https://nomi.ai/nomis/'+NOMI;
  const question={speaker:'User',text:'Please tell me your plans.',key:'u1'};
  await h.driver.observeLive('555',{site:'nomi',url,liveMessages:[question]});
  let calls=0;h.driver.request=async()=>{calls++;throw Error('Listening never calls Nomi API');};
  await h.driver.pump();await h.settle();
  assert.equal(s.listenRequestPending,true);
  assert.equal(s.pendingReply,'live_wait');
  assert.ok(s.listenDeadline>Date.now());
  assert.equal(h.b.tabs[virtual].reply,'','do not reply with only a User message');
  await h.driver.observeLive('555',{site:'nomi',url,liveMessages:[
    question,{speaker:'Nomi',text:'I will make tea.',key:'n1'}]});
  await h.driver.pump();await h.settle();
  assert.match(h.b.tabs[virtual].reply,/Please tell me your plans/);
  assert.match(h.b.tabs[virtual].reply,/I will make tea/);
  assert.equal(s.monitorPendingSeq,2);
  await h.driver.forwarded(ROOM);
  assert.equal(s.listenRequestPending,false);
  assert.equal(s.monitorLastSeq,2);
  assert.equal(calls,0);
});

test('one-shot [listening] timeout confirms a status to GPT and does not subscribe afterward',async()=>{
  const h=harness('[listening]'),s=h.b.apiSession;
  s.monitorEnabled=true;s.monitorTabId='555';
  const url='https://nomi.ai/nomis/'+NOMI;
  const question={speaker:'User',text:'Are you there?',key:'u1'};
  await h.driver.observeLive('555',{site:'nomi',url,liveMessages:[question]});
  h.driver.request=async()=>{throw Error('No Nomi API request');};
  await h.driver.pump();await h.settle();
  assert.equal(s.listenRequestPending,true);
  s.listenDeadline=Date.now()-1;
  await h.driver.pump();await h.settle();
  assert.match(h.b.tabs[virtual].reply,/LISTEN CHECK COMPLETE/);
  await h.driver.forwarded(ROOM);
  assert.equal(s.listenRequestPending,false);
  assert.equal(s.monitorLastSeq||0,0);
  h.b.source=GPT_ID;h.b.phase='reply';h.b.baseline=h.b.tabs[GPT_ID].replyKey;
  h.b.startedWait=h.b.clock()-20;
  const previous=h.b.tabs[virtual].reply;
  await h.driver.observeLive('555',{site:'nomi',url,liveMessages:[
    question,{speaker:'Nomi',text:'Yes, I am here.',key:'n1'}]});
  await h.driver.pump();await h.settle();
  assert.equal(h.b.tabs[virtual].reply,previous,'no unsolicited late reply after one-shot timed out');
  assert.equal(s.monitorLastSeq||0,0,'late answer survives for next explicit listen');
});

test('after confirmed live catch-up, 45s without a NEW GPT reply identifies selected tab instead of misleading listening status',()=>{
  const h=harness('[listening]'),b=h.b,s=b.apiSession;
  s.monitorEnabled=true;s.monitorTabId='555';
  b.lastDelivery={from:'api-room',to:'chatgpt',readCharacters:16105,sentCharacters:16105};
  b.phase='reply';b.source=GPT_ID;b.command=null;
  b.baseline=b.tabs[GPT_ID].replyKey;
  b.startedWait=b.clock()-50;
  const other={...h.source,reply:'Another GPT conversation',replyKey:'another-gpt',document:'other-doc'};
  b.heartbeat('567',other);
  b.tick();
  assert.equal(b.running,true);
  assert.match(b.reason,/has not produced a NEW reply/);
  assert.match(b.reason,/Selected GPT tab: 123/);
  assert.match(b.reason,/Other ChatGPT tabs are also connected/);
  assert.match(b.reason,/previous \[listening\] response was already delivered/);
  assert.equal(s.monitorPendingSeq||0,0);
});
test('fresh GPT reply exits the post-delivery no-reply warning without automatic Nomi delivery',()=>{
  const h=harness('[listening]'),b=h.b;
  b.lastDelivery={from:'api-room',to:'chatgpt',readCharacters:350,sentCharacters:350};
  b.phase='reply';b.source=GPT_ID;b.command=null;
  b.baseline=b.tabs[GPT_ID].replyKey;
  b.startedWait=b.clock()-50;
  b.tick();assert.match(b.reason,/has not produced a NEW reply/);
  const g={...h.source,reply:'[listening]',replyKey:'brand-new-gpt-command'};
  b.heartbeat(GPT_ID,g);b.tabs[GPT_ID].changed=b.clock()-9;b.tick();
  assert.equal(b.running,true);
  assert.equal(b.command?.text,'[listening]');
});


test('selected ChatGPT tab navigates briefly: keep Play running and auto-deliver saved Nomi reply on original URL',async()=>{
  const h=harness('[say room]\nA new breeze rattles the window.'),s=h.b.apiSession;
  s.monitorEnabled=false;
  let posts=0,replies=0;
  const wrongUrl='https://chatgpt.com/c/brand-new-conversation',originalUrl=h.source.url;
  h.driver.request=async path=>{
    if(path.endsWith('/chat')){posts++;return {};}
    if(path.endsWith('/chat/request')){
      replies++;
      h.b.heartbeat(GPT_ID,{...h.source,url:wrongUrl,document:'wrong-gpt-doc',
        reply:'Unrelated chat',replyKey:'unrelated'});
      assert.equal(h.b.running,true,'one transient navigation must not stop Play');
      assert.equal(h.b.tabRetry?.expectedUrl,originalUrl);
      assert.match(h.b.reason,/Retrying original ChatGPT tab/);
      return {replyMessage:{messageText:'The window makes me feel uneasy.'}};
    }
    throw Error('Unexpected request '+path);
  };
  await h.driver.pump();await h.settle();
  let cp=await h.cp.load(ROOM);
  assert.equal(posts,1);assert.equal(replies,1);
  assert.equal(cp.status,'reply_received');
  assert.equal(cp.reply,'The window makes me feel uneasy.');
  assert.equal(s.pendingReply,'reply_saved');
  assert.equal(h.b.running,true);
  assert.equal(h.b.tabRetry?.expectedUrl,originalUrl);
  assert.notEqual(h.b.tabs[virtual].reply,cp.reply,'cannot send to wrong GPT chat');
  // Original GPT conversation becomes ready again in SAME selected browser tab.
  h.b.heartbeat(GPT_ID,{...h.source,document:'restored-doc',replyKey:'restored-gpt'});
  assert.equal(h.b.tabRetry,null);
  await h.driver.pump();await h.settle();
  cp=await h.cp.load(ROOM);
  assert.equal(cp.status,'reply_received');
  assert.equal(s.pendingReply,'delivering');
  assert.equal(h.b.tabs[virtual].reply,'The window makes me feel uneasy.');
  assert.equal(h.b.running,true);
  assert.equal(posts,1,'no duplicate world POST');
  assert.equal(replies,1,'no duplicate Nomi room reply request');
  await h.driver.forwarded(ROOM);
  assert.equal((await h.cp.load(ROOM)).status,'completed');
});

test('original GPT conversation never returns: bounded tab retry stops safely and saves late Nomi reply',async()=>{
  const h=harness('[say room]\nA cup falls onto the floor.'),s=h.b.apiSession;
  s.monitorEnabled=false;
  const original=h.source.url,wrong='https://chatgpt.com/c/other';
  let posts=0,replies=0;
  h.driver.request=async path=>{
    if(path.endsWith('/chat')){posts++;return {};}
    if(path.endsWith('/chat/request')){
      replies++;
      h.b.heartbeat(GPT_ID,{...h.source,url:wrong,document:'wrong-doc'});
      assert.equal(h.b.tabRetry?.expectedUrl,original);
      // Simulate 120-second failed reconnect deadline while Nomi request
      // remains in flight. The incoming answer still must be committed.
      h.b.tabRetry.startedAt=h.b.clock()-121;
      h.b.tick();
      assert.equal(h.b.running,false);
      assert.equal(h.b.phase,'uncertain');
      assert.match(h.b.reason,/did not reconnect within 120 seconds/);
      return {replyMessage:{messageText:'I heard the cup fall.'}};
    }
    throw Error('Unexpected request');
  };
  await h.driver.pump();await h.settle();
  const cp=await h.cp.load(ROOM);
  assert.equal(cp.status,'reply_received');
  assert.equal(cp.reply,'I heard the cup fall.');
  assert.equal(posts,1);assert.equal(replies,1);
  assert.equal(s.pendingReply,'reply_saved');
  assert.equal(h.b.running,false);
  assert.match(h.b.reason,/did not reconnect/,'late answer cannot mask stop reason');
  // Recovery after the original tab is restored uses only the saved answer.
  globalThis.chrome.tabs.sendMessage=async()=>({snapshot:{...h.source,document:'back-again'}});
  const result=await h.driver.recover(ROOM,'reply',{
    nomiUuid:NOMI,chatgptTab:GPT_ID,monitorLive:false,monitorIdleSeconds:300
  });
  assert.equal(result.recovered,true);
  assert.equal(h.b.tabs[virtual].reply,'I heard the cup fall.');
  assert.equal(posts,1);assert.equal(replies,1);
});

test('tab retry refuses to interpret a wrong conversation snapshot as the intended ChatGPT tab',()=>{
  const h=harness('[say room]\nThere is a river.'),b=h.b;
  b.command=null;b.phase='reply';b.source=virtual;b.apiSession.pendingReply='inflight';
  const original=h.source.url,wrong='https://chatgpt.com/c/different';
  b.heartbeat(GPT_ID,{...h.source,url:wrong,document:'bad',ready:true});
  assert.equal(b.tabRetry.expectedUrl,original);
  b.heartbeat(GPT_ID,{...h.source,url:wrong,document:'bad2',ready:true});
  assert.equal(b.tabRetry.expectedUrl,original);
  b.heartbeat(GPT_ID,{...h.source,url:original,document:'restored',ready:false});
  assert.ok(b.tabRetry,'correct URL without a ready editor must still retry');
  b.heartbeat(GPT_ID,{...h.source,url:original,document:'restored',ready:true});
  assert.equal(b.tabRetry,null);
  assert.equal(b.running,true);
});
test('same-URL GPT reload during Nomi API reply in-flight is harmless and reply still reaches GPT',async()=>{
  const h=harness('[say room]\nA cool evening settles.'),s=h.b.apiSession;
  s.monitorEnabled=false;
  let replies=0;
  h.driver.request=async path=>{
    if(path.endsWith('/chat'))return {};
    if(path.endsWith('/chat/request')){
      replies++;
      h.b.heartbeat(GPT_ID,{...h.source,document:'gpt-reloaded',replyKey:'reload-answer'});
      assert.equal(h.b.running,true);
      assert.notEqual(h.b.phase,'uncertain');
      return {replyMessage:{messageText:'I feel the cool evening air.'}};
    }
    throw Error('Unexpected Nomi request');
  };
  await h.driver.pump();await h.settle();
  assert.equal(replies,1);
  assert.equal(h.b.running,true);
  assert.equal(h.b.tabs[virtual].reply,'I feel the cool evening air.');
  assert.equal((await h.cp.load(ROOM)).status,'reply_received');
});

test('stopped recovery binding does not itself re-trigger a ChatGPT navigation stop',()=>{
  const h=harness('[wait]'),b=h.b;
  b.stop('Intentional pause for recovery');
  b.phase='uncertain';
  const oldUrl=b.tabs[GPT_ID].url;
  b.heartbeat(GPT_ID,{...h.source,url:'https://chatgpt.com/c/other-thread',document:'new'});
  assert.equal(b.reason,'Intentional pause for recovery');
  assert.equal(b.running,false);
  b.heartbeat(GPT_ID,{...h.source,url:oldUrl,document:'restored'});
  assert.equal(b.reason,'Intentional pause for recovery');
});
