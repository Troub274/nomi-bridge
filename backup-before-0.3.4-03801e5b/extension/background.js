importScripts('engine.js');
let bridge;
let queue = Promise.resolve();
async function load() {
  if (!bridge) {
    const saved = await chrome.storage.session.get('bridge');
    bridge = new Bridge(undefined, saved.bridge || {});
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
  transaction(async () => {
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
      case '/api/state': return bridge.state();
      case '/api/play': bridge.start(data); return bridge.state();
      case '/api/stop': bridge.stop(); return bridge.state();
      case '/api/reset': bridge.reset(); return bridge.state();
      default: throw Error('Unsupported control request');
    }
  }).then(reply, error => reply({error: error.message}));
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
