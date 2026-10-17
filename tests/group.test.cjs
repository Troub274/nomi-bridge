const {test} = require('node:test');
const assert = require('node:assert/strict');
const {GroupBridge, parseGroupCommand, limitGroupText} = require('../extension/group.js');
test('send acknowledgment commits own message snapshot before invite is queued',()=>{
 const f=setup();f.begin();f.reply('[say] hello room\n[invite] Gwen');f.advance();f.ack();f.advance();
 const c=f.b.command;assert.equal(c.action,'say');f.b.claim('b',c.id);
 f.room.messages.push({speaker:'User',text:'hello room',occurrence:1});f.room.roomKey='committed-own-message';
 f.b.acknowledge('b',{id:c.id,snapshot:{...f.room}});assert.equal(f.b.command,null);
 f.advance();assert.equal(f.b.command.action,'invite');assert.equal(f.b.command.roomKey,'committed-own-message');
});
test('listening resumes paused and user-turn rooms, but internal acknowledgments never do',()=>{
 for(const state of [{autoChat:'paused',userTurn:false},{autoChat:'enabled',userTurn:true}]) {
  const f=setup();Object.assign(f.room,state);f.beat();f.begin();f.reply('[listening]');assert.equal(f.b.command.action,'play');assert.equal(f.b.command.text,'');
 }
 const f=setup();f.room.autoChat='paused';f.beat();f.ack();f.reply('[listening]');f.advance();assert.equal(f.b.command.packet,true);assert.equal(f.b.command.target,'a');
});
test('a new GPT batch after listening is handled once without requiring room activity',()=>{
 const f=setup();f.begin();f.reply('[listening]');f.advance();assert.equal(f.b.command,null);
 f.reply('[say] First message\n\n[say] Second message\n\n[invite] Gwen',false);f.advance(30);assert.equal(f.b.command,null);
 f.gpt.complete=true;f.beat();f.advance();f.advance();assert.equal(f.b.command.action,'pause');f.ack();f.advance();
 assert.equal(f.b.command.text,'First message');f.ack();f.advance();assert.equal(f.b.command.text,'Second message');f.ack();f.advance();
 assert.equal(f.b.command.action,'invite');f.ack();f.advance();assert.equal(f.b.command.packet,true);f.ack();f.reply('[listening]');f.advance();assert.equal(f.b.command,null);assert.equal(f.b.turns,2);
});
test('ordered batch posts each message then releases chosen member; Stop preserves remaining queue',()=>{
 const f=setup();f.begin();f.reply('[say] first\n[say] '+ 'x'.repeat(850)+'\n[say] third\n[invite] Gwen');f.advance();
 assert.equal(f.b.command.action,'pause');f.ack();f.advance();
 assert.equal(f.b.command.text,'first');f.ack();f.b.stop();f.advance();assert.equal(f.b.command,null);
 f.b.start({mode:'group',tabs:['a','b']});assert.equal(f.b.command.text.length,800);f.ack();f.advance();
 assert.equal(f.b.command.text,'x'.repeat(50));f.ack();f.advance();
 assert.equal(f.b.command.text,'third');f.ack();f.advance();assert.equal(f.b.command.action,'invite');assert.equal(f.b.command.member,'Gwen');f.ack();f.advance();
 assert.ok(!f.b.command.internal);assert.equal(f.b.turns,4);
});
test('batch parser supports arbitrary message count and rejects misplaced controls',()=>{
 const {parseGroupBatch}=require('../extension/group.js');
 assert.equal(parseGroupBatch(Array.from({length:100},(_,i)=>'[say] '+i).join('\n')+'\n[play]').commands.length,101);
 assert.ok(parseGroupBatch('[play]\n[say] later').error);
});
function setup() {
  let time = 100, turn = 0;
  const b = new GroupBridge(() => time);
  const gpt = {site:'chatgpt',reply:'old',replyKey:'old',url:'https://chatgpt.com/c/test',document:'a',ready:true,complete:true,busy:false,draft:false};
  const room = {site:'nomi',room:true,reply:'hello',replyKey:'hello',url:'https://beta.nomi.ai/group-chats/1',document:'b',ready:true,complete:true,busy:false,draft:false,autoChat:'enabled',userTurn:false,members:['Gwen','test'],messages:[{speaker:'Gwen',text:'hello',occurrence:1}],roomKey:'initial'};
  const beat = () => {b.heartbeat('a',gpt); b.heartbeat('b',room);};
  const advance = (n = 9) => {time += n; beat();};
  const ack = () => {const c = b.command; assert.ok(c); assert.equal(b.claim(c.target,c.id).allowed,true); b.acknowledge(c.target,{id:c.id}); return c;};
  const reply = (text, complete = true) => {Object.assign(gpt,{reply:text,replyKey:String(++turn),complete}); beat(); advance();};
  beat(); b.start({mode:'group',tabs:['a','b'],settle:8});
  const begin = () => {assert.ok(b.command.internal); ack(); reply('[listening]'); advance(); assert.ok(b.command.packet); ack();};
  return {b,gpt,room,beat,advance,ack,reply,begin};
}
test('startup instructions and acknowledgments never become room messages',()=>{
  const f=setup(); assert.match(f.b.command.text,/\[help\]/); f.ack();
  f.reply('[say] This acknowledgment must stay internal'); f.advance();
  assert.equal(f.b.command.target,'a'); assert.equal(f.b.command.internal,undefined);
  assert.match(f.b.command.text,/Gwen/); assert.equal(f.b.turns,0);
});
test('listening permits multiple room updates without sending to Nomis or polling GPT',()=>{
  const f=setup(); f.begin(); f.reply('[wait]'); f.advance(); assert.equal(f.b.command,null);
  f.room.messages.push({speaker:'test',text:'another reply',occurrence:1}); f.room.roomKey='new'; f.beat(); f.advance();
  assert.equal(f.b.command.target,'a'); assert.match(f.b.command.text,/another reply/); f.ack(); f.reply('[listening]');
  for(let i=0;i<200;i++) f.advance(); assert.equal(f.b.running,true); assert.equal(f.b.command,null);
});
test('long group response is delivered completely without truncation notices',()=>{
  const f=setup(); f.begin(); f.reply('[say] '+ 'x'.repeat(850));
  f.advance();assert.equal(f.b.command.action,'pause');f.ack();f.advance();
  const first=f.ack();assert.equal(first.text.length,800);assert.equal(first.truncated,false);f.advance();
  const second=f.ack();assert.equal(first.text+second.text,'x'.repeat(850));f.advance();assert.ok(!f.b.command.internal);
});
test('chunking preserves all characters and emoji across word boundaries',()=>{
 const {chunkGroupText}=require('../extension/group.js');
 for(const text of ['a'.repeat(799)+'😀 end',('word paragraph\n').repeat(500),'x'.repeat(10000)]) {
  const parts=chunkGroupText(text);assert.equal(parts.join(''),text);assert.ok(parts.every(p=>p.length<=800));assert.ok(parts.every(p=>!/[\uD800-\uDBFF]$/.test(p)));
 }
});
test('hard limit keeps emoji intact',()=>{assert.equal(limitGroupText('x'.repeat(799)+'😀').length,799); assert.equal(limitGroupText('x'.repeat(800)).length,800);});
test('complete response controls required even after long quiet periods',()=>{
  const f=setup(); f.begin(); f.reply('[say] tiny',false); f.advance(60); assert.equal(f.b.command,null);
  f.reply('[say] Finished response',true); assert.equal(f.b.command.text,'Finished response');
});
test('new room activity during GPT generation refreshes context instead of sending stale reply',()=>{
  const f=setup(); f.begin(); f.room.messages.push({speaker:'test',text:'new question',occurrence:1}); f.room.roomKey='changed'; f.beat();
  f.reply('[say] stale answer'); f.advance(); assert.equal(f.b.command.target,'a'); assert.match(f.b.command.text,/new question/);
});
test('help and invalid commands are internal',()=>{
  for(const text of ['[help]','just an untagged response','[play] [say] oops']) {
    const f=setup(); f.begin(); f.reply(text); f.advance(); assert.equal(f.b.command.target,'a'); assert.equal(f.b.command.internal,true);
  }
});
test('invite validates membership and duplicate names',()=>{
  const f=setup(); f.begin(); f.reply('[invite] Gwen'); assert.equal(f.b.command.member,'Gwen'); assert.equal(f.b.command.text,'');
  const g=setup(); g.room.members=['Gwen','Gwen']; g.begin(); g.reply('[invite] Gwen'); g.advance(); assert.equal(g.b.command.internal,true);
});
test('pause, play and send are separate commands',()=>{
  for(const action of ['pause','play']) {const f=setup(); f.begin(); f.reply('['+action+']'); assert.equal(f.b.command.action,action); assert.equal(f.b.command.text,'');}
});
test('Stop revokes pending controls, restore preserves claimed commands, no duplicate execution',()=>{
  const f=setup(); f.begin(); f.reply('[play]'); const c=f.b.command; f.b.claim('b',c.id); f.b.stop();
  assert.equal(f.b.claim('b',c.id,true).allowed,false);
  const restored=new GroupBridge(f.b.clock,f.b.serialize()); restored.start({mode:'group',tabs:['a','b']});
  assert.equal(restored.claim('b',c.id).allowed,false); assert.equal(restored.command.id,c.id);
});
test('snapshot changes during source validation fail closed',()=>{
  const f=setup(); f.begin(); f.reply('[say] hello'); const c=f.b.command;
  assert.equal(f.b.validateSource(c.id,{...f.gpt,reply:'different'}),false); assert.equal(f.b.running,false);
});
test('room packets keep newer messages queued until subsequent delivery',()=>{
  const f=setup(); f.begin(); f.reply('[wait]'); f.room.messages.push({speaker:'test',text:'one',occurrence:1}); f.room.roomKey='one'; f.beat(); f.advance();
  const packet=f.b.command; f.room.messages.push({speaker:'test',text:'two',occurrence:1}); f.room.roomKey='two'; f.beat();
  assert.equal(f.b.validateSource(packet.id),true); f.ack(); f.reply('[listening]'); f.advance(); assert.match(f.b.command.text,/two/); assert.doesNotMatch(f.b.command.text,/"text":"one"/);
});
test('parser accepts case variants and rejects missing payloads',()=>{
  assert.equal(parseGroupCommand('[LISTENING]').action,'listening'); assert.ok(parseGroupCommand('[say]').error); assert.ok(parseGroupCommand('[wait] blah').error);
});
