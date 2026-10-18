importScripts('engine.js', 'group.js', 'heartbeat.js', 'api-room.js', 'api-checkpoint.js', 'world-observer.js', 'api-driver.js');
let bridge;
let queue = Promise.resolve();
const apiDriver = new NomiApiDriver(() => bridge, transaction);
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
  const apiMode = data.mode === 'api-room' || data.mode === 'heartbeat';
  const ids = apiMode ? [data.tabs?.[0]] : data.tabs || [data.chatgpt,data.nomi];
  if (!Array.isArray(ids) || ids.length !== (apiMode ? 1 : 2) || ids.some(id=>!/^\d+$/.test(String(id))) || (!apiMode && String(ids[0]) === String(ids[1]))) throw Error('Select the required chat tabs.');
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
      if (info?.snapshot) await transaction(async () => {
        await apiDriver.observeLive(String(t.id),info.snapshot);
        const {liveMessages,...rest}=info.snapshot;
        bridge.heartbeat(String(t.id),{...rest,browser:'Edge',window:t.windowId});
      });
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
  state.apiRoom = apiDriver.publicState();
  return state;
}
async function load() {
  if (!bridge) {
    const saved = await chrome.storage.session.get('bridge');
    bridge = new (globalThis.HeartbeatBridge || GroupBridge)(undefined, saved.bridge || {});
    const interrupted = bridge.mode === 'api-room' && (
      bridge.apiSession?.pendingReply === 'inflight' ||
      (bridge.phase === 'send' && bridge.command?.claimed && bridge.tabs[bridge.command.target]?.site === 'api-room'));
    if (interrupted) {
      bridge.phase = 'uncertain';
      bridge.stop('An API room request was interrupted. Check the room and Reset; do not resend blindly.');
    }
  }
  return bridge;
}
function transaction(fn) {
  const operation = queue.then(async () => {
    await load();
    let result;
    try {apiDriver.touch(); result = await fn();}
    finally {apiDriver.touch(); await chrome.storage.session.set({bridge: bridge.serialize()});}
    return result;
  });
  queue = operation.catch(() => {});
  void operation.then(() => queueMicrotask(() => void apiDriver.pump()), () => {});
  return operation;
}
async function verifySource(command) {
  if (command?.groupCommand && command.packet) return bridge.validateSource(command.id);
  // API room replies have no browser tab. Validate the immutable virtual snapshot.
  if (bridge.mode === 'api-room' && bridge.tabs[command?.source]?.site === 'api-room')
    return bridge.validateSource(command.id, bridge.tabs[command.source]);
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
  if (control && message.path==='/api/stop') apiDriver.stopWaiting();
  const ticket = control && message.path === '/api/play' ? ++startupGeneration : null;
  const preparation = ticket !== null ? wakeSelected(message.data || {},ticket) : control && message.path === '/api/state' ? discoverTabs() : Promise.resolve();
  preparation.then(async () => {
    // A recovery may wait indefinitely for an explicit Nomi not-ready response.
    // Start it outside the serialized transaction queue so Stop/status still work.
    if (control && ['/api/api-recover-send','/api/api-recover-reply'].includes(message.path)) {
      await load();
      const data=message.data||{};
      return apiDriver.startRecovery(data.roomId,
        message.path==='/api/api-recover-send'?'send':'reply',data);
    }
    return transaction(async () => {
    const data = message.data || {};
    if (sender.tab && /^https:\/\/(chatgpt\.com|chat\.openai\.com|(?:[a-z0-9-]+\.)?nomi\.ai)\//.test(sender.url || '')) {
      const tab = String(sender.tab.id);
      if (message.path === '/api/heartbeat') {
        await apiDriver.observeLive(tab,data.snapshot);
        const {liveMessages,...snapshot}=data.snapshot||{};
        const result = bridge.heartbeat(tab, {...snapshot, browser: 'Edge', window: sender.tab.windowId});
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
      if (message.path === '/api/ack') {
        const cmd=bridge.command;
        const shouldCommit=cmd?.id===data.id && cmd.claimed && !data.error &&
          bridge.mode==='api-room' && bridge.tabs[cmd.source]?.site==='api-room';
        const result=bridge.acknowledge(tab,data);
        if (shouldCommit) await apiDriver.forwarded(bridge.apiSession.roomId);
        return result;
      }
      throw Error('Unsupported chat request');
    }
    if (!sender.url?.startsWith(chrome.runtime.getURL(''))) throw Error('Unsupported sender');
    switch (message.path) {
      case '/api/state': return discoveredState();
      case '/api/play':
        if (ticket !== startupGeneration) throw Error('Startup cancelled.');
        if (apiDriver.inFlight) throw Error('A Nomi API operation is still in progress.');
        if (data.mode === 'api-room') await apiDriver.prepareStart(data);
        bridge.start(data);
        if(data.mode==='api-room' && data.monitorLive && data.monitorTab){
          try {
            const info=await chrome.tabs.sendMessage(Number(data.monitorTab),{type:'inspect'});
            await apiDriver.observeLive(String(data.monitorTab),info?.snapshot);
          }catch(error){bridge.log('Private-chat monitor is waiting for the selected tab to reconnect.');}
        }
        return bridge.state();
      case '/api/nomi-key':
        if (bridge.running || apiDriver.inFlight) throw Error('Stop the bridge first.');
        return apiDriver.setKey(data.key);
      case '/api/clear-nomi-key':
        if (bridge.running || apiDriver.inFlight) throw Error('Stop the bridge first.');
        return apiDriver.clearKey();
      case '/api/api-config': return apiDriver.configured();
      case '/api/api-catalog': return apiDriver.catalog();
      case '/api/api-checkpoint': return apiDriver.checkpointState(data.roomId);
      case '/api/api-journal': return apiDriver.journalState(data.roomId);
      case '/api/api-clear-journal': return apiDriver.clearJournal(data.roomId);
      case '/api/api-abandon':
        if (apiDriver.inFlight || apiDriver.recoveryScheduled) throw Error('Stop and let the active API operation finish before abandoning.');
        return apiDriver.abandon(data.roomId);
      case '/api/api-create-room':
        if (bridge.running || apiDriver.inFlight || apiDriver.recoveryScheduled) throw Error('Stop the bridge before creating an API room.');
        return apiDriver.createRoom(data.nomiUuid,data.name,data.note);
      case '/api/api-update-room-note':
        return apiDriver.updateRoomNote(data.roomId,data.note,data.expectedNote);
      case '/api/api-delete-room':
        return apiDriver.deleteRoom(data.roomId,data.nomiUuid,data.confirmName);
      case '/api/stop': bridge.stop(); return bridge.state();
      case '/api/reset':
        if (apiDriver.inFlight) throw Error('Nomi API request is still in progress. Stop and inspect before resetting.');
        bridge.reset();
        bridge.apiSession = null;
        return bridge.state();
      default: throw Error('Unsupported control request');
    }
    });
  }).then(reply, error => reply({error: error.message}));
  return true;
});
// Retry the selected GPT TAB, not the Nomi room POST. On Edge reload the
// content script may not yet be installed, so inspect/reinject as needed.
// Never inject or send to a different ChatGPT conversation URL.
async function retrySelectedGPTTab(){
  const state=await transaction(()=>{
    if(!bridge.running||bridge.mode!=='api-room')return null;
    const selected=String(bridge.pair?.[0]||'');
    const trusted=bridge.tabRetry?.expectedUrl||bridge.tabs[selected]?.url;
    return /^\d+$/.test(selected)&&/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(trusted||'')
      ?{selected,expectedUrl:trusted}:null;
  });
  if(!state)return;
  let tab;
  try{tab=await bounded(chrome.tabs.get(Number(state.selected)));}
  catch{return;}
  if(tab?.url!==state.expectedUrl){
    await transaction(()=>{
      if(bridge.running&&bridge.pair?.[0]===state.selected)
        bridge.retryGPTTab(state.selected,tab?.url||'',state.expectedUrl);
    });
    return;
  }
  if(tab.discarded||tab.status==='loading')return;
  try{
    let info;
    try{info=await bounded(chrome.tabs.sendMessage(tab.id,{type:'inspect'}));}catch{}
    if(!info?.snapshot){
      await bounded(chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']}));
      info=await bounded(chrome.tabs.sendMessage(tab.id,{type:'inspect'}));
    }
    if(info?.snapshot?.url!==state.expectedUrl||info.snapshot.site!=='chatgpt')return;
    await transaction(()=>{
      if(bridge.running&&bridge.pair?.[0]===state.selected)
        bridge.heartbeat(state.selected,{...info.snapshot,window:tab.windowId,browser:'Edge'});
    });
  }catch{
    // A transient sleeping/loading page will be checked on the next alarm.
  }
}
// Wake selected content scripts even when inactive-tab timers are throttled.
chrome.alarms.create('bridge-wake', {periodInMinutes: 0.5});
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'bridge-wake') return;
  const ids = await transaction(() => {
    apiDriver.touch(); bridge.tick();
    if(!bridge.running)return [];
    const ids=bridge.pair.filter(id => /^\d+$/.test(String(id)));
    const monitor=bridge.apiSession?.monitorEnabled && bridge.apiSession.monitorTabId;
    if(bridge.mode==='api-room' && monitor && !ids.includes(monitor))ids.push(monitor);
    return ids;
  });
  await Promise.allSettled([
    ...ids.map(id => chrome.tabs.sendMessage(Number(id), {type: 'wake'})),
    retrySelectedGPTTab()
  ]);
});
// Observe tab navigation immediately instead of waiting for a potentially
// missing heartbeat from the old conversation's content script.
chrome.tabs.onUpdated?.addListener?.((id,changeInfo) => {
  if(!changeInfo.url)return;
  transaction(()=>{
    const selected=String(id);
    if(bridge.running&&bridge.mode==='api-room'&&bridge.pair?.[0]===selected)
      bridge.retryGPTTab(selected,changeInfo.url,bridge.tabs[selected]?.url);
  }).catch(()=>{});
});
chrome.tabs.onRemoved.addListener(id => {
  transaction(() => {
    const key = String(id);
    if (bridge.pair?.includes(key)) {bridge.phase = 'uncertain'; bridge.stop('A selected chat tab closed. Choose chats and Reset before continuing.');}
    if (bridge.mode==='api-room' && bridge.apiSession?.monitorTabId===key){
      bridge.apiSession.monitorTabId='';
      bridge.apiSession.monitorSeen=0;
      bridge.apiSession.monitorCount=0;
      bridge.log('Live Nomi chat closed. Falling back to API room responses until it reconnects.');
    }
    delete bridge.tabs[key];
  }).catch(() => {});
});
