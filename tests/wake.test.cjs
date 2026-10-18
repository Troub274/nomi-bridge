const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {HeartbeatBridge:GroupBridge}=require('../extension/heartbeat.js');
function harness(cancel=false){
 let listener,request;const activated=[],injected=[];const tabs=[1,2,3].map(id=>({id,url:'https://chatgpt.com/c/'+id,windowId:1,discarded:true,status:'complete'}));
 const NomiApiDriver=class {constructor(){} touch(){} publicState(){return null;} pump(){} async observeLive(){} stopWaiting(){}};
const context={NomiApiDriver,queueMicrotask,GroupBridge,setTimeout,clearTimeout,importScripts(){},chrome:{runtime:{getURL:()=> 'chrome-extension://bridge/',onMessage:{addListener:fn=>listener=fn}},storage:{session:{get:async()=>({}),set:async()=>{}}},alarms:{create(){},onAlarm:{addListener(){}}},scripting:{executeScript:async({target})=>injected.push(target.tabId)},tabs:{get:async id=>tabs[id-1],update:async id=>{activated.push(id);tabs[id-1].discarded=false;if(cancel)await request('stop');},sendMessage:async id=>{if(!injected.includes(id))throw Error('no script');return {snapshot:{site:'chatgpt',url:tabs[id-1].url,document:String(id),ready:true,busy:false,draft:false,reply:'hello',replyKey:'hello',complete:true}};},onRemoved:{addListener(){}}}}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../extension/background.js'),'utf8'),context);
 request=(path,data={})=>new Promise(resolve=>listener({path:'/api/'+path,data},{tab:{id:99},url:'chrome-extension://bridge/dashboard.html'},resolve));
 return {request,activated,injected};
}
test('Play wakes only selected tabs and connects scripts before starting',async()=>{
 const h=harness();const result=await h.request('play',{tabs:['1','2']});assert.equal(result.running,true);assert.deepEqual(h.activated,[1,2]);assert.deepEqual(h.injected,[1,2]);
});
test('Stop cancels startup before another tab is activated or bridge starts',async()=>{
 const h=harness(true);const result=await h.request('play',{tabs:['1','2']});assert.match(result.error,/cancelled/);assert.deepEqual(h.activated,[1]);
});
test('Heartbeat Play wakes only the selected GPT tab',async()=>{
 const h=harness();const result=await h.request('play',{mode:'heartbeat',tabs:['1'],heartbeatText:'Continue.',heartbeatDelay:10});
 assert.equal(result.running,true);assert.equal(result.mode,'heartbeat');assert.deepEqual(h.activated,[1]);assert.deepEqual(h.injected,[1]);
});
