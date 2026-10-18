const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const {Bridge}=require('../extension/engine.js');
const {apiRoomId}=require('../extension/api-room.js');

test('background wakes and reinjects only the original GPT tab after temporary wrong-conversation navigation',async()=>{
  const ROOM='12345678-1234-1234-1234-123456789012';
  const virtual=apiRoomId(ROOM),selected='123';
  const original='https://chatgpt.com/c/world',wrong='https://chatgpt.com/c/other';
  const bridge=new Bridge();
  const t=bridge.clock();
  const snapshot={site:'chatgpt',url:original,document:'original-doc',
    reply:'Hello',replyKey:'one',ready:true,busy:false,complete:true,draft:false,error:''};
  bridge.tabs={
    [selected]:{...snapshot,id:selected,seen:t,changed:t},
    [virtual]:{site:'api-room',id:virtual,seen:t,changed:t,ready:true,
      busy:true,complete:true,draft:false,reply:'',replyKey:'',
      url:'api-room:'+ROOM,document:virtual}
  };
  bridge.mode='api-room';
  bridge.running=true;
  bridge.phase='reply';
  bridge.source=virtual;
  bridge.pair=[selected,virtual];
  // Model an active, checkpointed reply wait before an API request begins.
  // A newly booted worker with 'inflight' correctly enters uncertain recovery.
  bridge.apiSession={roomId:ROOM,pendingReply:'ready',monitorEnabled:false};
  let url=wrong,connected=false,updates=0;
  const reinjections=[];
  let onUpdate,onAlarm;
  const driver=class{
    constructor(){} touch(){} pump(){} publicState(){return null;}
    observeLive(){return Promise.resolve();} stopWaiting(){}
  };
  const chrome={
    runtime:{getURL:()=> 'chrome-extension://bridge/',
      onMessage:{addListener(){}}},
    storage:{session:{get:async()=>({bridge:bridge.serialize()}),set:async()=>{}}},
    tabs:{
      get:async()=>({id:123,url,windowId:7,status:'complete',discarded:false}),
      sendMessage:async(id,message)=>{
        if(!connected)throw Error('No content script');
        if(message.type==='inspect')return {snapshot:{...snapshot,document:'restored-doc'}};
        return {ok:true};
      },
      onUpdated:{addListener:fn=>onUpdate=fn},
      onRemoved:{addListener(){}}
    },
    scripting:{executeScript:async args=>{
      reinjections.push(args.target.tabId);
      assert.equal(url,original,'never inject into a different conversation');
      connected=true;
    }},
    alarms:{create(){},onAlarm:{addListener:fn=>onAlarm=fn}}
  };
  let active;
  class InstrumentedBridge extends Bridge {
    constructor(...args){super(...args);active=this;}
  }
  vm.runInNewContext(fs.readFileSync(require.resolve('../extension/background.js'),'utf8'),
    {NomiApiDriver:driver,GroupBridge:InstrumentedBridge,Bridge,queueMicrotask,
     setTimeout,clearTimeout,importScripts(){},chrome});
  onUpdate(123,{url:wrong});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(active.tabRetry?.expectedUrl,original,JSON.stringify({
    running:active.running,mode:active.mode,source:active.source,
    phase:active.phase,pair:active.pair,pending:active.apiSession?.pendingReply,
    selected:active.tabs[selected]?.url,reason:active.reason
  }));
  assert.equal(active.running,true);
  assert.equal(reinjections.length,0);
  await onAlarm({name:'bridge-wake'});
  assert.equal(reinjections.length,0,'wrong chat URL cannot receive the content script');
  assert.equal(active.running,true);
  url=original;
  await onAlarm({name:'bridge-wake'});
  assert.deepEqual(reinjections,[123]);
  assert.equal(active.tabRetry,null,'correct GPT conversation automatically reconnects');
  assert.equal(active.running,true);
  assert.equal(active.tabs[selected].url,original);
});
