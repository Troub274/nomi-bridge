const {test}=require('node:test'),assert=require('node:assert/strict');
const {HeartbeatBridge}=require('../extension/heartbeat.js');
test('classic worker scripts expose the fourth-mode engine without replacing group lexical binding',()=>{
 const vm=require('node:vm'),fs=require('node:fs');const ctx=vm.createContext({crypto});
 for(const name of ['engine','group','heartbeat'])vm.runInContext(fs.readFileSync(require.resolve('../extension/'+name+'.js'),'utf8'),ctx);
 assert.equal(vm.runInContext('new globalThis.HeartbeatBridge() instanceof GroupBridge',ctx),true);
 assert.match(vm.runInContext('HeartbeatBridge.prototype.start.toString()',ctx),/heartbeatText/);
});
function setup(){
 let now=100;let b=new HeartbeatBridge(()=>now);
 let snap={site:'chatgpt',url:'https://chatgpt.com/c/one',document:'doc',ready:true,busy:false,draft:false,reply:'',replyKey:'',complete:true};
 const update=(patch={})=>{snap={...snap,...patch};return b.heartbeat('1',snap);};
 const advance=n=>{now+=n;update();};
 const start=()=>b.start({mode:'heartbeat',tabs:['1'],heartbeatText:'Continue.',settle:3});
 const send=()=>{const c=b.command;assert.ok(c);assert.equal(b.validateSource(c.id,snap),true);assert.equal(b.claim('1',c.id).allowed,true);b.acknowledge('1',{id:c.id});return c;};
 const reply=text=>{update({reply:text,replyKey:String(now)+text,complete:true,busy:false});advance(3);};
 update();return {get b(){return b;},update,advance,start,send,reply,restore(){b=new HeartbeatBridge(()=>now,JSON.parse(JSON.stringify(b.serialize())));}};
}
test('single-tab first pulse includes controls; repeats phrase only after completed reply and default 10s',()=>{
 const h=setup();h.start();assert.match(h.b.command.text,/\[sleep nHRS\]/);h.send();
 h.update({busy:true,complete:false,reply:'partial',replyKey:'r'});h.advance(500);assert.equal(h.b.command,null);
 h.reply('Done');h.advance(9);assert.equal(h.b.command,null);h.advance(1);assert.equal(h.b.command.text,'Continue.');
});
test('standalone sleep switches off, Play explicitly resumes',()=>{
 const h=setup();h.start();h.send();h.reply('[sleep]');assert.equal(h.b.running,false);h.advance(10000);assert.equal(h.b.command,null);h.start();assert.ok(h.b.command);
});
test('timed sleep survives worker restore and resumes once at deadline',()=>{
 const h=setup();h.start();h.send();h.reply('[sleep 0.5HRS]');assert.equal(h.b.phase,'pulse-sleep');h.restore();h.advance(1799);assert.equal(h.b.command,null);h.advance(1);assert.ok(h.b.command);h.send();h.advance(2000);assert.equal(h.b.command,null);
});
test('Stop prevents timed resumption',()=>{
 const h=setup();h.start();h.send();h.reply('[sleep 1HRS]');h.b.stop();h.restore();h.advance(3601);assert.equal(h.b.command,null);assert.equal(h.b.running,false);
});
test('quoted commands and partial streaming command cannot stop heartbeat',()=>{
 const h=setup();h.start();h.send();h.update({reply:'[sleep]',replyKey:'new',busy:true,complete:false});h.advance(30);assert.equal(h.b.running,true);h.reply('Example: [sleep]');h.advance(10);assert.ok(h.b.command);
});
test('draft prevents sends and navigation stops the session',()=>{
 const h=setup();h.start();h.send();h.reply('Done');h.update({draft:true});h.advance(20);assert.equal(h.b.command,null);h.update({draft:false,url:'https://chatgpt.com/c/other'});assert.equal(h.b.running,false);
});
test('Stop revokes claimed send permit and restore never duplicates it',()=>{
 const h=setup();h.start();const c=h.b.command;h.b.claim('1',c.id);h.b.stop();assert.equal(h.b.claim('1',c.id,true).allowed,false);h.restore();h.advance(200);assert.equal(h.b.running,false);
});
test('configured delay and validation',()=>{
 const h=setup();assert.throws(()=>h.b.start({mode:'heartbeat',tabs:['1'],heartbeatText:'x',heartbeatDelay:0}));
 h.b.start({mode:'heartbeat',tabs:['1'],heartbeatText:'x',heartbeatDelay:20,settle:3});h.send();h.reply('ok');h.advance(19);assert.equal(h.b.command,null);h.advance(1);assert.ok(h.b.command);
});
