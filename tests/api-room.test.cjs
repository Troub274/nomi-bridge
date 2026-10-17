const {test} = require('node:test');
const assert = require('node:assert/strict');
const {GroupBridge} = require('../extension/group.js');
const helpers = require('../extension/api-room.js');
globalThis.NomiApiRoom = helpers;
const {NomiApiDriver} = require('../extension/api-driver.js');

function fixture(text) {
  let now = 100;
  const b = new GroupBridge(() => now);
  const roomId = '12345678-1234-1234-1234-123456789012';
  const virtual = helpers.apiRoomId(roomId);
  const nomiUuid = '22222222-2222-2222-2222-222222222222';
  const gpt = {site:'chatgpt',reply:text,replyKey:'turn-1',url:'https://chatgpt.com/c/test',
    document:'gpt-test',ready:true,busy:false,complete:true,draft:false,error:''};
  const room = {site:'api-room',reply:'',replyKey:'',url:'api-room:'+roomId,
    document:virtual,ready:true,busy:false,complete:true,draft:false,error:''};
  b.heartbeat('1',gpt);
  b.heartbeat(virtual,room);
  b.apiSession = {roomId,nomiUuid,nomiName:'Gwen',roomName:'World',
    pendingReply:'none',sequence:0};
  b.start({mode:'api-room',tabs:['1',virtual],first:'first',settle:8});
  now += 9;
  b.heartbeat('1',gpt);
  b.heartbeat(virtual,room);
  assert.equal(b.command?.text,text,'entire GPT response must be queued');
  globalThis.chrome = {tabs:{sendMessage:async()=>({snapshot:{...b.tabs['1']}})}};
  return {b,virtual,roomId,nomiUuid,driver:new NomiApiDriver(()=>b,async fn=>fn())};
}

test('API room chunks preserve arbitrary text, emojis and Unicode, with a <=800-byte cap',()=>{
  const originals = ['x'.repeat(10000),'😀'.repeat(2000),'abc\n\n'.repeat(2000),
    'a'.repeat(799)+'😀'+'z'.repeat(801),'é漢🍂'.repeat(1500)];
  for (const content of originals) {
    const chunks = helpers.apiChunks(content);
    assert.equal(chunks.join(''),content);
    assert.ok(chunks.every(x=>Buffer.byteLength(x,'utf8')<=800));
    assert.ok(chunks.every(x=>x.length<=800));
    assert.ok(chunks.every(x=>!/[\uD800-\uDBFF]$/.test(x)));
  }
});

test('API room posts the full GPT turn as chunks and requests exactly one Nomi reply',async()=>{
  const full='😀 hello world. '.repeat(600);
  const f=fixture(full), sent=[];
  let replies=0;
  f.driver.request = async(path, method, body)=>{
    if (path.endsWith('/chat')) { sent.push(body.messageText); return {}; }
    if (path.endsWith('/chat/request')) {replies++;return {replyMessage:{messageText:'I am here.'}};}
    throw Error('Unexpected call '+path);
  };
  await f.driver.pump();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(sent.join(''),full);
  assert.equal(sent.length,helpers.apiChunks(full).length);
  assert.equal(replies,1);
  assert.equal(f.b.tabs[f.virtual].reply,'I am here.');
  assert.equal(f.b.apiSession.pendingReply,'none');
  assert.equal(f.b.turns,1,'many chunks still count as one conversation turn');
});

test('ambiguous failure during a multipart POST never replays committed chunks',async()=>{
  const f=fixture('z'.repeat(2000));
  const delivered=[];
  f.driver.request = async(path,method,body)=>{
    if (path.endsWith('/chat')) {
      delivered.push(body.messageText);
      if (delivered.length===2) throw Error('Connection lost after unknown delivery');
      return {};
    }
    if (path.endsWith('/chat/request')) throw Error('Reply must not be requested after partial delivery');
    throw Error('Unexpected call '+path);
  };
  await f.driver.pump();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(delivered.length,2);
  assert.equal(f.b.running,false);
  assert.equal(f.b.phase,'uncertain');
  assert.equal(f.b.apiSession.progress.confirmed,1);
  await f.driver.pump();
  assert.equal(delivered.length,2,'uncertain chunks must never be retried automatically');
});
