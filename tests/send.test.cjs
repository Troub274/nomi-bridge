const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require.resolve('../extension/content.js'),'utf8');
async function simulate(replaceButton, richMode) {
 let clicks=0,ack;
 class TextArea {
  constructor(){this.text='';this.disabled=false;this.isConnected=true;}
  get value(){return this.text;} set value(v){this.text=v;}
  getClientRects(){return [{}];} getAttribute(){return null;} focus(){} dispatchEvent(){}
 }
  const input=richMode ? {innerText:'',isContentEditable:true,disabled:false,isConnected:true,getClientRects:()=>[{}],getAttribute:()=>null,focus(){}} : new TextArea();
 const message=richMode?'Hello Nomi.\n\n[Bridge reminder: Keep replies within 750 characters.]':'Hello';
 function button(){return {disabled:false,isConnected:true,getClientRects:()=>[{}],getAttribute:()=>null,click(){if(this.isConnected){clicks++;if(richMode)input.innerText='';else input.value='';}}};}
 let currentButton=button();
 const context={location:{hostname:richMode?'chatgpt.com':'beta.nomi.ai',href:'https://beta.nomi.ai/nomis/test'},crypto:globalThis.crypto,
 HTMLTextAreaElement:TextArea,HTMLInputElement:class{},Event:class{},getComputedStyle:()=>({visibility:'visible'}),
 window:{getSelection:()=>({removeAllRanges(){},addRange(){}})},document:{createRange:()=>({selectNodeContents(){}}),execCommand(cmd,ui,text){input.innerText=richMode==='corrupt'?text.slice(0,10):text.replace(/\n/g,'\n\n').replace(/ /g,'\u00a0');return true;},title:'Nomi',querySelectorAll(selector){if(selector.startsWith('textarea')||selector.startsWith('#prompt-textarea'))return [input];if(selector.startsWith('button')&&!selector.includes('stop-button'))return [currentButton];return [];}},
 setInterval:()=>{},setTimeout:fn=>{setImmediate(fn);},
 chrome:{storage:{local:{get:async()=>({})},onChanged:{addListener:()=>{}}},runtime:{onMessage:{addListener:()=>{}},sendMessage:async m=>{
  if(m.path==='/api/heartbeat')return {command:{id:'cmd',url:context.location.href,document:m.data.snapshot.document,text:message}};
  if(m.path==='/api/claim'){
   if(m.data.checkOnly&&replaceButton){currentButton.isConnected=false;currentButton=button();}
   return {allowed:true};
  }
  if(m.path==='/api/ack'){ack=m.data;return {};}
 }}}};
 vm.runInNewContext(source,context);
 for(let i=0;i<250&&!ack;i++)await new Promise(r=>setImmediate(r));
 return {clicks,ack};
}
test('submits without a manual click',async()=>{const r=await simulate(false);assert.equal(r.clicks,1);assert.equal(r.ack.error,undefined);});
test('submits with the current button when the page replaces it during authorization',async()=>{const r=await simulate(true);assert.equal(r.clicks,1);assert.equal(r.ack.error,undefined);});

test('rich-editor paragraph and nonbreaking-space formatting still sends automatically',async()=>{
 const r=await simulate(true,'format');assert.equal(r.clicks,1);assert.equal(r.ack.error,undefined);
});
test('rich-editor missing words still blocks submission',async()=>{
 const r=await simulate(false,'corrupt');assert.equal(r.clicks,0);assert.match(r.ack.error,/Editor text differs/);
});

