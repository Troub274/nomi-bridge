const fs=require('node:fs');
let p='browser_bridge/extension/engine.js',s=fs.readFileSync(p,'utf8');
s=s.replace('claimed: false, created: now, baseline: dest.replyKey','claimed: false, created: now, baseline: dest.replyKey,\n      source: this.source, sourceReply: source.reply, sourceKey: source.replyKey, sourceDocument: source.document, sourceUrl: source.url, previousPhase: this.phase');
s=s.replace('  claim(tab, id, checkOnly = false) {',`  validateSource(id, snapshot) {
    const cmd = this.command;
    if (!cmd || cmd.id !== id || !this.running || this.phase !== 'send') return false;
    const valid = snapshot && !snapshot.error && !snapshot.busy && snapshot.complete !== false &&
      snapshot.reply === cmd.sourceReply && snapshot.replyKey === cmd.sourceKey &&
      snapshot.document === cmd.sourceDocument && snapshot.url === cmd.sourceUrl;
    if (valid) return true;
    if (cmd.claimed) {
      this.phase = 'uncertain';
      this.stop('The source reply changed before Send. Nothing further will be sent; check the draft and Reset.');
    } else {
      this.phase = cmd.previousPhase || 'reply'; this.command = null;
      if (snapshot && cmd.source) this.heartbeat(cmd.source, snapshot);
      this.reason = 'Reply changed or is still generating. Waiting for the complete reply.';
    }
    return false;
  }
  claim(tab, id, checkOnly = false) {`);
fs.writeFileSync(p,s);
p='browser_bridge/extension/background.js';s=fs.readFileSync(p,'utf8');
s=s.replace('chrome.runtime.onMessage.addListener',`async function verifySource(command) {
  if (!command?.source) {bridge.stop('Reloaded an older queued message. Reset before continuing.'); return false;}
  let timeout;
  try {
    const info = await Promise.race([
      chrome.tabs.sendMessage(Number(command.source), {type: 'inspect'}),
      new Promise((_, reject) => {timeout = setTimeout(() => reject(Error('Source tab did not respond')), 3000);})
    ]);
    return bridge.validateSource(command.id, info?.snapshot);
  } catch (error) {
    bridge.stop('Could not verify the complete reply: ' + error.message);
    return false;
  } finally {clearTimeout(timeout);}
}
chrome.runtime.onMessage.addListener`);
s=s.replace('        if (result.command) {','        if (result.command) {\n          if (!await verifySource(result.command)) return {};');
s=s.replace("      if (message.path === '/api/claim') return bridge.claim(tab, data.id, data.checkOnly);", "      if (message.path === '/api/claim') {\n        if (data.checkOnly && (!bridge.command || !await verifySource(bridge.command))) return {allowed:false};\n        return bridge.claim(tab, data.id, data.checkOnly);\n      }");
fs.writeFileSync(p,s);
p='browser_bridge/tests/background.test.cjs';s=fs.readFileSync(p,'utf8');
s=s.replace("text:'hi',claimed:false,created:now", "text:'hi',claimed:false,created:now,source:'1',sourceReply:'old',sourceKey:'old',sourceDocument:'doc',sourceUrl:snapshot.url");
s=s.replace('const context={Bridge,importScripts:', 'const context={Bridge,setTimeout,clearTimeout,importScripts:');
s=s.replace('tabs:{update:', "tabs:{sendMessage:async()=>({snapshot}),update:");fs.writeFileSync(p,s);
p='browser_bridge/extension/manifest.json';const m=JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));m.version='0.1.5';fs.writeFileSync(p,JSON.stringify(m,null,2)+'\n');
