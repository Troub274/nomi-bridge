const fs=require('node:fs');
const p='browser_bridge/extension/background.js';let s=fs.readFileSync(p,'utf8');
s=s.replace('  transaction(() => {\n    const data = message.data || {};','  transaction(async () => {\n    const data = message.data || {};');
s=s.replace("      if (message.path === '/api/heartbeat') return bridge.heartbeat(tab, {...data.snapshot, browser: 'Edge', window: sender.tab.windowId});", `      if (message.path === '/api/heartbeat') {
        const result = bridge.heartbeat(tab, {...data.snapshot, browser: 'Edge', window: sender.tab.windowId});
        if (result.command) {
          // Keep the receiving editor out of inactive-tab timer throttling during Send.
          // This selects a tab inside Edge; it does not bring Edge over another app.
          try {await chrome.tabs.update(sender.tab.id, {active: true});}
          catch (error) {bridge.stop('Cannot activate the receiving chat: ' + error.message); return {};}
        }
        return result;
      }`);
fs.writeFileSync(p,s);
const dp='browser_bridge/extension/dashboard.html';s=fs.readFileSync(dp,'utf8');s=s.replace('<summary>Activity</summary>','<summary>Activity</summary><button id="copy-status" class="small">Copy troubleshooting status</button>');fs.writeFileSync(dp,s);
const jp='browser_bridge/extension/dashboard.js';s=fs.readFileSync(jp,'utf8');s+='\n'+`$('copy-status').onclick = async () => {
  try {
    const state = await request('state');
    const report = {version: chrome.runtime.getManifest().version, running: state.running, phase: state.phase, reason: state.reason,
      turns: state.turns, events: state.events, tabs: state.tabs.map(t => ({site:t.site, connected:t.connected, ready:t.ready,
        busy:t.busy, draft:t.draft, replyCharacters:t.reply?.length || 0, matches:t.matches, diagnostic:t.diagnostic}))};
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    $('copy-status').textContent = 'Copied — paste into our conversation';
  } catch (error) {$('error').textContent = error.message;}
};
`;fs.writeFileSync(jp,s);
const rp='browser_bridge/README.md';s=fs.readFileSync(rp,'utf8');s=s.replace(/\nVersion 0\.1\.2[^]*$/,'');s+='\nVersion 0.1.3 sends one message per turn. ChatGPT replies longer than 775 characters are cut to 775 for Nomi, with no extra parts sent. Each Nomi reply goes back to ChatGPT next. The receiving tab is selected automatically before Send to avoid inactive-tab delays. Use Activity → Copy troubleshooting status to report a stall; it excludes message text.\n';fs.writeFileSync(rp,s);
