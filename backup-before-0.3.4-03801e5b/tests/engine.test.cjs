const {test} = require('node:test');
const assert = require('node:assert/strict');
const {Bridge} = require('../extension/engine.js');
function fixture() {
  let time = 100;
  const bridge = new Bridge(() => time);
  const snapshots = Object.fromEntries(['a','b'].map((id,i) => [id, {site:i?'nomi':'chatgpt', reply:'opening '+id, replyKey:'initial '+id, ready:true,busy:false,draft:false,url:'https://example/'+id,document:id}]));
  const beat = (id, changes={}) => {Object.assign(snapshots[id],changes); return bridge.heartbeat(id,snapshots[id]);};
  const advance = (seconds=9) => {time+=seconds; beat('a');beat('b');};
  const play = () => bridge.start({chatgpt:'a',nomi:'b'});
  const deliver = () => {const c=bridge.command; assert.ok(c);assert.ok(bridge.claim(c.target,c.id).allowed);bridge.acknowledge(c.target,{id:c.id});};
  beat('a');beat('b');
  return {bridge,beat,advance,play,deliver};
}
test('120 alternating turns without a turn limit',()=>{
 const f=fixture(); f.play(); f.advance();
 for(let i=0;i<120;i++){f.deliver(); f.beat(f.bridge.source,{reply:'turn '+i,replyKey:'turn '+i});f.advance();}
 assert.equal(f.bridge.turns,120);assert.equal(f.bridge.running,true);
});
test('waits through streaming and then quiet time',()=>{
 const f=fixture();f.play();f.advance();f.deliver();
 f.beat('b',{reply:'partial',replyKey:'new',busy:true});f.advance(30);assert.equal(f.bridge.command,null);
 f.beat('b',{reply:'complete',busy:false});f.advance(4);assert.equal(f.bridge.command,null);
 f.advance(5);assert.equal(f.bridge.command.text,'complete');
});
test('stop revokes send and resume retains pending reply',()=>{
 const f=fixture();f.play();f.advance();f.deliver();f.bridge.stop();f.beat('b',{reply:'new',replyKey:'new'});f.advance();
 assert.equal(f.bridge.command,null);f.play();assert.equal(f.bridge.command.text,'new');
 const c=f.bridge.command;assert.ok(f.bridge.claim(c.target,c.id).allowed);assert.equal(f.bridge.claim(c.target,c.id).allowed,false);
 f.bridge.stop();assert.equal(f.bridge.claim(c.target,c.id,true).allowed,false);
});
test('uncertain send cannot be replayed',()=>{
 const f=fixture();f.play();f.advance();const c=f.bridge.command;f.bridge.claim(c.target,c.id);f.advance(91);
 assert.equal(f.bridge.phase,'uncertain');assert.throws(f.play,/uncertain/);
});
test('late ack cannot clear navigation uncertainty',()=>{
 const f=fixture();f.play();f.advance();const c=f.bridge.command;f.bridge.claim(c.target,c.id);
 f.beat('b',{url:'https://example/other'});f.bridge.acknowledge(c.target,{id:c.id});assert.equal(f.bridge.phase,'uncertain');
});
test('existing drafts block play',()=>{
 const f=fixture();f.beat('b',{draft:true});assert.throws(f.play,/draft/);
});
test('session restoration preserves claimed command without resending',()=>{
 const f=fixture();f.play();f.advance();const c=f.bridge.command;f.bridge.claim(c.target,c.id);
 const restored=new Bridge(f.bridge.clock,JSON.parse(JSON.stringify(f.bridge.serialize())));
 assert.equal(restored.claim(c.target,c.id).allowed,false);assert.equal(restored.phase,'send');
});
test('wrong tab cannot claim or acknowledge',()=>{
 const f=fixture();f.play();f.advance();const c=f.bridge.command;
 assert.equal(f.bridge.claim('a',c.id).allowed,false);f.bridge.acknowledge('a',{id:c.id});assert.equal(f.bridge.turns,0);
});
test('session storage updates do not trigger a heartbeat feedback loop',async()=>{
 const vm=require('node:vm');const fs=require('node:fs');let listener;let calls=0;
 const context={location:{hostname:'chatgpt.com',href:'https://chatgpt.com/c/test'},crypto:globalThis.crypto,
 document:{title:'test',querySelectorAll:()=>[]},setInterval:()=>{},setTimeout,
 chrome:{storage:{local:{get:async()=>({})},onChanged:{addListener:fn=>listener=fn}},runtime:{onMessage:{addListener:()=>{}},sendMessage:async()=>{calls++;return {};}}}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../extension/content.js'),'utf8'),context);
 await new Promise(r=>setImmediate(r));assert.equal(calls,1);
 listener({bridge:{newValue:{}}},'session');await new Promise(r=>setImmediate(r));assert.equal(calls,1);
 listener({chatgpt:{newValue:{}}},'local');await new Promise(r=>setImmediate(r));assert.equal(calls,2);
});


test('one Nomi turn is at most 750 characters and does not split emoji',()=>{
 const {limitNomiMessage}=require('../extension/engine.js');
 assert.equal(limitNomiMessage('x'.repeat(750)).length,750);
 assert.equal(limitNomiMessage('x'.repeat(1600)),'x'.repeat(750));
 assert.equal(limitNomiMessage('x'.repeat(749)+'😀'),'x'.repeat(749));
});
test('long GPT turn goes once to Nomi, then Nomi returns to GPT, then GPT goes to Nomi',()=>{
 const f=fixture();f.beat('a',{reply:'x'.repeat(1600),replyKey:'long'});f.play();f.advance();
 assert.equal(f.bridge.command.target,'b');assert.equal(f.bridge.command.text.length,750);f.deliver();
 f.advance();assert.equal(f.bridge.command,null);
 f.beat('b',{reply:'Nomi answers',replyKey:'nomi-new'});f.advance();
 assert.equal(f.bridge.command.target,'a');assert.ok(f.bridge.command.text.startsWith('Nomi answers\n\n[Bridge reminder:'));f.deliver();
 f.beat('a',{reply:'GPT answers',replyKey:'gpt-new'});f.advance();
 assert.equal(f.bridge.command.target,'b');assert.equal(f.bridge.command.text,'GPT answers');
});
test('old chunk queue cannot leak into an updated session',()=>{
 const b=new Bridge(()=>100,{pendingNomi:['old extra text'],running:true});
 assert.equal(b.running,false);assert.equal(b.phase,'uncertain');assert.equal(b.pendingNomi,undefined);
});
test('reading Nomi reply does not require Nomi editor to be ready',()=>{
 const f=fixture();f.play();f.advance();f.deliver();
 f.beat('b',{reply:'Nomi answers',replyKey:'new',ready:false});f.advance();
 assert.equal(f.bridge.command.target,'a');
});

test('a ten-character partial GPT reply is never sent during a long quiet pause',()=>{
 const f=fixture();f.beat('a',{reply:'Only start',replyKey:'new',complete:false});f.play();f.advance(45);
 assert.equal(f.bridge.command,null);
 f.beat('a',{reply:'Full response '.repeat(100),replyKey:'complete',complete:true});f.advance();
 assert.equal(f.bridge.command.target,'b');assert.equal(f.bridge.command.text.length,750);
});

test('queued 10-character snapshot is discarded when a fresh read shows more text',()=>{
 const f=fixture();f.beat('a',{reply:'Only start',replyKey:'short',complete:true});f.play();f.advance();
 const c=f.bridge.command;
 const current={...f.bridge.tabs.a,reply:'Now the full answer is visible',replyKey:'full',complete:true};
 assert.equal(f.bridge.validateSource(c.id,current),false);assert.equal(f.bridge.command,null);assert.equal(f.bridge.running,true);
});
test('queued reply is discarded when current response is still streaming',()=>{
 const f=fixture();f.play();f.advance();const c=f.bridge.command;
 assert.equal(f.bridge.validateSource(c.id,{...f.bridge.tabs.a,busy:true}),false);assert.equal(f.bridge.command,null);
});
test('final check blocks sending an already-filled partial draft',()=>{
 const f=fixture();f.play();f.advance();const c=f.bridge.command;f.bridge.claim(c.target,c.id);
 assert.equal(f.bridge.validateSource(c.id,{...f.bridge.tabs.a,reply:'expanded answer'}),false);
 assert.equal(f.bridge.running,false);assert.equal(f.bridge.claim(c.target,c.id,true).allowed,false);
});

test('reminder is appended only after confirmed truncation and consumed once',()=>{
 const f=fixture();f.beat('a',{reply:'x'.repeat(751),replyKey:'long'});f.play();f.advance();
 assert.equal(f.bridge.remindChatGPT,false);f.deliver();assert.equal(f.bridge.remindChatGPT,true);
 f.bridge.stop();f.beat('b',{reply:'Hello from Nomi',replyKey:'new'});f.advance();f.play();
 const c=f.bridge.command;assert.ok(c.text.startsWith('Hello from Nomi\n\n[Bridge reminder:'));
 assert.ok(c.text.includes('750 characters'));assert.equal(c.sourceReply,'Hello from Nomi');
 assert.equal(f.bridge.validateSource(c.id,f.bridge.tabs.b),true);
 f.deliver();assert.equal(f.bridge.remindChatGPT,false);
 f.beat('a',{reply:'Short reply',replyKey:'short'});f.advance();f.deliver();
 f.beat('b',{reply:'Next Nomi reply',replyKey:'next'});f.advance();assert.equal(f.bridge.command.text,'Next Nomi reply');
});
test('exactly 750 characters does not trigger a reminder',()=>{
 const f=fixture();f.beat('a',{reply:'x'.repeat(750),replyKey:'boundary'});f.play();f.advance();f.deliver();
 assert.equal(f.bridge.remindChatGPT,false);
});
test('pending reminder survives session restoration and clears on reset',()=>{
 const f=fixture();f.beat('a',{reply:'x'.repeat(751),replyKey:'long'});f.play();f.advance();f.deliver();
 const b=new Bridge(f.bridge.clock,JSON.parse(JSON.stringify(f.bridge.serialize())));
 assert.equal(b.remindChatGPT,true);b.stop();b.reset();assert.equal(b.remindChatGPT,false);
});

for (const site of ['chatgpt', 'nomi']) {
 test(`${site} to ${site} alternates two distinct chats`, () => {
  const f = fixture();
  f.beat('a', {site, reply:'x'.repeat(900)}); f.beat('b', {site});
  f.bridge.start({tabs:['a','b'], first:'second'}); f.advance();
  assert.equal(f.bridge.command.target, 'a'); f.deliver();
  f.beat('a', {reply:'x'.repeat(900), replyKey:'new response'}); f.advance();
  assert.equal(f.bridge.command.target, 'b');
  assert.equal(f.bridge.command.text.length, site === 'nomi' ? 750 : 900);
  f.deliver(); assert.equal(f.bridge.turns, 2);
  assert.equal(f.bridge.remindChatGPT, false);
 });
}
test('same chat cannot be both sides of the bridge', () => {
 const f=fixture(); assert.throws(() => f.bridge.start({tabs:['a','a']}), /different/);
});
test('unsupported chat site is rejected', () => {
 const f=fixture(); f.beat('b',{site:'other'});
 assert.throws(() => f.bridge.start({tabs:['a','b']}), /connected/);
});
