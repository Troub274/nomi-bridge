const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {GroupBridge}=require('../extension/group.js');
const NomiApiDriver=class {constructor(){} touch(){} publicState(){return null;} pump(){} async observeLive(){} stopWaiting(){}};

test('discovers existing tabs, injects only missing scripts and lists sleeping tabs without refreshing',async()=>{
 let listener;const injected=[];const connected=new Set([1]);
 const tabs=[1,2,3].map(id=>({id,url:'https://chatgpt.com/c/'+id,title:'Chat '+id,windowId:1,discarded:id===3}));
 const context={NomiApiDriver,queueMicrotask,GroupBridge,setTimeout,clearTimeout,importScripts(){},chrome:{
  runtime:{onMessage:{addListener:fn=>listener=fn},getURL:()=> 'chrome-extension://bridge/'},
  storage:{session:{get:async()=>({}),set:async()=>{}}},alarms:{create(){},onAlarm:{addListener(){}}},
  scripting:{executeScript:async({target,files})=>{assert.deepEqual(Array.from(files),['content.js']);injected.push(target.tabId);connected.add(target.tabId);}},
  tabs:{query:async()=>tabs,sendMessage:async id=>{if(!connected.has(id))throw Error('No receiver');return {snapshot:{site:'chatgpt',url:tabs[id-1].url,document:String(id),ready:true,reply:'',replyKey:'',busy:false}};},onRemoved:{addListener(){}}}
 }};
 vm.runInNewContext(fs.readFileSync(require.resolve('../extension/background.js'),'utf8'),context);
 const state=()=>new Promise(resolve=>listener({path:'/api/state'},{tab:{id:99},url:'chrome-extension://bridge/dashboard.html'},resolve));
 await state();await new Promise(r=>setImmediate(r));
 const first=await state();assert.equal(first.tabs.length,3);assert.equal(first.tabs[1].connected,true);assert.equal(first.tabs[2].connected,false);assert.deepEqual(injected,[2]);
 await state();assert.deepEqual(injected,[2]);tabs.pop();assert.equal((await state()).tabs.length,2);
});

test('an unresponsive tab cannot block the dropdown or Stop',async()=>{
 let listener;const timers=[];
 const context={NomiApiDriver,queueMicrotask,GroupBridge,setTimeout:(fn,ms)=>{const t=setTimeout(fn,ms);timers.push(t);return t;},clearTimeout,importScripts(){},chrome:{
 runtime:{onMessage:{addListener:fn=>listener=fn},getURL:()=> 'chrome-extension://bridge/'},storage:{session:{get:async()=>({}),set:async()=>{}}},alarms:{create(){},onAlarm:{addListener(){}}},
 tabs:{query:async()=>[{id:1,url:'https://chatgpt.com/c/1',title:'Frozen tab'}],sendMessage:()=>new Promise(()=>{}),onRemoved:{addListener(){}}},scripting:{executeScript:()=>new Promise(()=>{})}}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../extension/background.js'),'utf8'),context);
 const request=path=>new Promise(resolve=>listener({path:'/api/'+path},{tab:{id:99},url:'chrome-extension://bridge/dashboard.html'},resolve));
 try {
  const state=await Promise.race([request('state'),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('Dashboard blocked')),200);timers.push(t);})]);
  assert.equal(state.tabs.length,1);assert.equal((await request('stop')).running,false);
 } finally {timers.forEach(clearTimeout);}
});
