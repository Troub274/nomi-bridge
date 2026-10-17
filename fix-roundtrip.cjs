const fs=require('node:fs');
const p='browser_bridge/extension/engine.js';let s=fs.readFileSync(p,'utf8');
const begin=s.indexOf('function splitNomiMessage('),end=s.indexOf('class Bridge {');
s=s.slice(0,begin)+`function limitNomiMessage(text) {
  if (text.length <= NOMI_MESSAGE_LIMIT) return text;
  let end = NOMI_MESSAGE_LIMIT;
  if (/[\\uD800-\\uDBFF]/.test(text[end - 1]) && /[\\uDC00-\\uDFFF]/.test(text[end])) end--;
  return text.slice(0, end);
}
`+s.slice(end);
s=s.replace('baseline: null, pendingNomi: [], turns: 0,','baseline: null, turns: 0,');
s=s.replace('    this.clock = clock;', `    this.clock = clock;
    if (saved.pendingNomi?.length) {
      this.running = false; this.phase = 'uncertain'; this.command = null;
      this.reason = 'Updated to one message per turn. Reset before continuing.';
    }
    delete this.pendingNomi;`);
s=s.replaceAll(' this.pendingNomi = [];','');
s=s.replace("    const continuingNomi = this.pendingNomi.length > 0;\n    const target = continuingNomi ? this.pair[1] : this.pair.find(id => id !== this.source);", "    const target = this.pair.find(id => id !== this.source);");
s=s.replace("    if (!continuingNomi && dest.site === 'nomi') this.pendingNomi = splitNomiMessage(source.reply);\n    const text = dest.site === 'nomi' ? this.pendingNomi[0] : source.reply;", "    const text = dest.site === 'nomi' ? limitNomiMessage(source.reply) : source.reply;\n    if (text.length < source.reply.length) this.log('ChatGPT reply shortened to 775 characters for Nomi.');");
s=s.replace("this.phase = 'send'; this.log(continuingNomi ? 'Sending the next part to Nomi.' : `Forwarding ${source.site} → ${dest.site}.`);", "this.phase = 'send'; this.log(`Forwarding ${source.site} → ${dest.site}.`);");
s=s.replace("      if (this.tabs[tab].site === 'nomi') this.pendingNomi.shift();\n",'');
s=s.replace('module.exports = {Bridge, splitNomiMessage};','module.exports = {Bridge, limitNomiMessage};');
s=s.replace("    if (!source.ready || source.busy || !source.reply || now - source.seen > 70 || now - source.changed < this.stableSeconds) return;\n    if (this.phase === 'reply' && source.replyKey === this.baseline) return;", `    const speaker = source.site === 'nomi' ? 'Nomi' : 'ChatGPT';
    if (now - source.seen > 70) {this.reason = 'Waiting for ' + speaker + ' tab to reconnect.'; return;}
    if (source.busy) {this.reason = speaker + ' is still generating a reply.'; return;}
    if (!source.reply) {this.reason = 'No ' + speaker + ' reply detected. Check its reply preview.'; return;}
    if (this.phase === 'reply' && source.replyKey === this.baseline) {this.reason = 'Waiting for a new ' + speaker + ' reply. The detected reply has not changed.'; return;}
    if (now - source.changed < this.stableSeconds) {this.reason = 'Detected ' + speaker + ' reply; waiting for it to finish changing.'; return;}`);
s=s.replace("    if (!dest.ready || dest.busy || now - dest.seen > 70) return;", `    const receiver = dest.site === 'nomi' ? 'Nomi' : 'ChatGPT';
    if (now - dest.seen > 70) {this.reason = 'Waiting for ' + receiver + ' tab to reconnect.'; return;}
    if (!dest.ready) {this.reason = receiver + ' cannot receive yet: ' + (dest.diagnostic || 'check its editor and Send button'); return;}
    if (dest.busy) {this.reason = 'Waiting for ' + receiver + ' to finish generating before sending.'; return;}`);
fs.writeFileSync(p,s);
const tp='browser_bridge/tests/engine.test.cjs';s=fs.readFileSync(tp,'utf8');s=s.slice(0,s.indexOf("test('Nomi chunks preserve"));s+=`
test('one Nomi turn is at most 775 characters and does not split emoji',()=>{
 const {limitNomiMessage}=require('../extension/engine.js');
 assert.equal(limitNomiMessage('x'.repeat(775)).length,775);
 assert.equal(limitNomiMessage('x'.repeat(1600)),'x'.repeat(775));
 assert.equal(limitNomiMessage('x'.repeat(774)+'😀'),'x'.repeat(774));
});
test('long GPT turn goes once to Nomi, then Nomi returns to GPT, then GPT goes to Nomi',()=>{
 const f=fixture();f.beat('a',{reply:'x'.repeat(1600),replyKey:'long'});f.play();f.advance();
 assert.equal(f.bridge.command.target,'b');assert.equal(f.bridge.command.text.length,775);f.deliver();
 f.advance();assert.equal(f.bridge.command,null);
 f.beat('b',{reply:'Nomi answers',replyKey:'nomi-new'});f.advance();
 assert.equal(f.bridge.command.target,'a');assert.equal(f.bridge.command.text,'Nomi answers');f.deliver();
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
`;
fs.writeFileSync(tp,s);
const mp='browser_bridge/extension/manifest.json';const m=JSON.parse(fs.readFileSync(mp,'utf8').replace(/^\uFEFF/,''));m.version='0.1.3';fs.writeFileSync(mp,JSON.stringify(m,null,2)+'\n');
