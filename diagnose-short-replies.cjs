const fs=require('node:fs');
let p='browser_bridge/extension/content.js',s=fs.readFileSync(p,'utf8');
s=s.replace("    const streaming = [...turn.querySelectorAll('.result-streaming, [data-is-streaming=\"true\"], [aria-busy=\"true\"]')].some(visible);", "    const streamingSelector = '.result-streaming, [data-is-streaming=\"true\"], [aria-busy=\"true\"]';\n    const streaming = turn.matches(streamingSelector) || [...turn.querySelectorAll(streamingSelector)].some(visible);");
fs.writeFileSync(p,s);
p='browser_bridge/tests/reply.test.cjs';s=fs.readFileSync(p,'utf8').replace('streaming=false,container=true','streaming=false,rootStreaming=false,container=true').replace('const turn={querySelectorAll(selector){','const turn={matches:()=>rootStreaming,querySelectorAll(selector){');
s+=`\ntest('streaming marker on the response container blocks forwarding',async()=>{
 const s=await inspect({completed:true,rootStreaming:true});assert.equal(s.complete,false);
});\n`;
fs.writeFileSync(p,s);
p='browser_bridge/extension/engine.js';s=fs.readFileSync(p,'utf8');
s=s.replace('baseline: null, remindChatGPT: false, turns: 0,','baseline: null, remindChatGPT: false, lastDelivery: null, turns: 0,');
s=s.replace('    this.phase = \'send\'; this.log(`Forwarding ${source.site} → ${dest.site}.`);', "    this.phase = 'send'; this.log(`Forwarding ${source.site} → ${dest.site}: read ${source.reply.length} characters; sending ${text.length}.`);");
s=s.replace('      if (cmd.truncated) this.remindChatGPT = true;', `      this.lastDelivery = {from: this.tabs[cmd.source]?.site, to: this.tabs[tab].site,
        readCharacters: cmd.sourceReply?.length, sentCharacters: cmd.text.length,
        truncated: !!cmd.truncated, reminderAdded: !!cmd.includesReminder};
      this.log('Send confirmed: ' + cmd.text.length + ' characters to ' + this.tabs[tab].site + '.');
      if (cmd.truncated) this.remindChatGPT = true;`);
s=s.replace('events: this.events, tabs:', 'events: this.events, lastDelivery: this.lastDelivery, tabs:');
fs.writeFileSync(p,s);
p='browser_bridge/extension/dashboard.js';s=fs.readFileSync(p,'utf8').replace('turns: state.turns, events: state.events,','turns: state.turns, lastDelivery: state.lastDelivery, events: state.events,');fs.writeFileSync(p,s);
p='browser_bridge/extension/manifest.json';const m=JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));m.version='0.1.7';fs.writeFileSync(p,JSON.stringify(m,null,2)+'\n');
