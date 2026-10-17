importScripts('engine.js', 'group.js');
let bridge;
let queue = Promise.resolve();
const chatPatterns = ['https://chatgpt.com/*','https://chat.openai.com/*','https://nomi.ai/*','https://*.nomi.ai/*'];
let discovery;
const probing = new Set();
let availableTabs = [];
let startupGeneration = 0;
async function bounded(operation) {
  let timer;
  try {return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Tab did not respond')),2000);})]);}
  finally {clearTimeout(timer);}
}
async function wakeSelected(data, ticket) {
  const ids = data.tabs || [data.chatgpt,data.nomi];
  if (!Array.isArray(ids) || ids.length !== 2 || ids.some(id=>!/^\d+$/.test(String(id))) || String(ids[0]) === String(ids[1])) throw Error('Select two different chat tabs.');
  const check = () => {if (ticket !== startupGeneration) throw Error('Startup cancelled.');};
  await transaction(()=>{check();if(bridge.running)throw Error('Already running.');});
  const deadline = Date.now()+20000;
  const selected = [];
  // Validate both destinations before changing which tabs are active.
  for (const id of ids) {
    check(); const tab = await bounded(chrome.tabs.get(Number(id)));
    if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com|(?:[a-z0-9-]+\.)?nomi\.ai)\//.test(tab.url || '')) throw Error('Selected tab is no longer a supported chat.');
    selected.push(tab);
  }
  for (const tab of selected) {
    check(); await bounded(chrome.tabs.update(tab.id,{active:true}));
    let connected = false;
    while (Date.now()<deadline) {
      check();
      try {
        const current = await bounded(chrome.tabs.get(tab.id));
        if (current.url !== tab.url) throw Error('Selected chat navigated while waking.');
        if (!current.discarded && current.status !== 'loading') {
          let info;
          try {info=await bounded(chrome.tabs.sendMessage(tab.id,{type:'inspect'}));} catch {}
          check();
          if (!info?.snapshot) {
            await bounded(chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']}));
            info=await bounded(chrome.tabs.sendMessage(tab.id,{type:'inspect'}));
          }
          check();
          if (info?.snapshot?.url === tab.url && info.snapshot.ready) {
            await transaction(()=>{check();bridge.heartbeat(String(tab.id),{...info.snapshot,browser:'Edge',window:tab.windowId});});
            connected=true;break;
          }
        }
      } catch(error) {check();if(error.message.includes('navigated'))throw error;}
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    if (!connected) throw Error('Selected chat did not become ready. Check that it is signed in, then press Play again.');
  }
  check();
}
function discoverTabs() {
  if (discovery) return discovery;
  discovery = (async () => {
    const tabs = await bounded(chrome.tabs.query({url:chatPatterns}));
    availableTabs = tabs.map(t => ({id:String(t.id),site:/nomi\.ai\//.test(t.url) ? 'nomi' : 'chatgpt',room:/\/group-chats\/\d+/.test(t.url),title:t.title,url:t.url,browser:'Edge',window:t.windowId,connected:false,diagnostic:t.discarded ? 'Sleeping tab — open it to connect.' : 'Connecting…'}));
    // Populate the dropdown immediately. A suspended page must not hold the dashboard response open.
    void Promise.allSettled(tabs.map(async t => {
      if (t.discarded || t.status === 'loading' || probing.has(t.id)) return;
      probing.add(t.id);
      try {
      let info;
      try {info = await bounded(chrome.tabs.sendMessage(t.id,{type:'inspect'}));} catch {}
      if (!info?.snapshot) {
        await bounded(chrome.scripting.executeScript({target:{tabId:t.id},files:['content.js']}));
        info = await bounded(chrome.tabs.sendMessage(t.id,{type:'inspect'}));
      }
      if (info?.snapshot) await transaction(() => bridge.heartbeat(String(t.id),{...info.snapshot,browser:'Edge',window:t.windowId}));
      } catch (error) {
        const entry = availableTabs.find(x=>x.id===String(t.id));
        if(entry) entry.diagnostic = 'Not connected: '+error.message;
      } finally {probing.delete(t.id);}
    }));
  })().finally(() => {discovery = null;});
  return discovery;
}
function discoveredState() {
  const state = bridge.state();
  state.tabs = availableTabs.map(t => state.tabs.find(s => s.id === t.id && s.url === t.url) || t);
  return state;
}
async function load() {
  if (!bridge) {
    const saved = await chrome.storage.session.get('bridge');
    bridge = new GroupBridge(undefined, saved.bridge || {});
  }
  return bridge;
}
function transaction(fn) {
  const operation = queue.then(async () => {
    await load();
    let result;
    try {result = await fn();}
    finally {await chrome.storage.session.set({bridge: bridge.serialize()});}
    return result;
  });
  queue = operation.catch(() => {});
  return operation;
}
async function verifySource(command) {
  if (command?.groupCommand && command.packet) return bridge.validateSource(command.id);
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
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  // The dashboard runs in a tab too. Authenticate by extension URL, not absence of sender.tab.
  const control = sender.url?.startsWith(chrome.runtime.getURL(''));
  if (control && ['/api/stop','/api/reset'].includes(message.path)) startupGeneration++;
  const ticket = control && message.path === '/api/play' ? ++startupGeneration : null;
  const preparation = ticket !== null ? wakeSelected(message.data || {},ticket) : control && message.path === '/api/state' ? discoverTabs() : Promise.resolve();
  preparation.then(() => transaction(async () => {
    const data = message.data || {};
    if (sender.tab && /^https:\/\/(chatgpt\.com|chat\.openai\.com|(?:[a-z0-9-]+\.)?nomi\.ai)\//.test(sender.url || '')) {
      const tab = String(sender.tab.id);
      if (message.path === '/api/heartbeat') {
        const result = bridge.heartbeat(tab, {...data.snapshot, browser: 'Edge', window: sender.tab.windowId});
        if (result.command) {
          if (!await verifySource(result.command)) return {};
          // Keep the receiving editor out of inactive-tab timer throttling during Send.
          // This selects a tab inside Edge; it does not bring Edge over another app.
          try {await chrome.tabs.update(sender.tab.id, {active: true});}
          catch (error) {bridge.stop('Cannot activate the receiving chat: ' + error.message); return {};}
        }
        return result;
      }
      if (message.path === '/api/claim') {
        if (data.checkOnly && (!bridge.command || !await verifySource(bridge.command))) return {allowed:false};
        return bridge.claim(tab, data.id, data.checkOnly);
      }
      if (message.path === '/api/ack') return bridge.acknowledge(tab, data);
      throw Error('Unsupported chat request');
    }
    if (!sender.url?.startsWith(chrome.runtime.getURL(''))) throw Error('Unsupported sender');
    switch (message.path) {
      case '/api/state': return discoveredState();
      case '/api/play': if(ticket !== startupGeneration)throw Error('Startup cancelled.'); bridge.start(data); return bridge.state();
      case '/api/stop': bridge.stop(); return bridge.state();
      case '/api/reset': bridge.reset(); return bridge.state();
      default: throw Error('Unsupported control request');
    }
  })).then(reply, error => reply({error: error.message}));
  return true;
});
// Wake selected content scripts even when inactive-tab timers are throttled.
chrome.alarms.create('bridge-wake', {periodInMinutes: 0.5});
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'bridge-wake') return;
  const ids = await transaction(() => {bridge.tick(); return bridge.running ? [...bridge.pair] : [];});
  await Promise.allSettled(ids.map(id => chrome.tabs.sendMessage(Number(id), {type: 'wake'})));
});
chrome.tabs.onRemoved.addListener(id => {
  transaction(() => {
    const key = String(id);
    if (bridge.pair?.includes(key)) {bridge.phase = 'uncertain'; bridge.stop('A selected chat tab closed. Choose chats and Reset before continuing.');}
    delete bridge.tabs[key];
  }).catch(() => {});
});
