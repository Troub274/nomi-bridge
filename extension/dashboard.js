const versionLabel = document.getElementById('build-version');
if (versionLabel) versionLabel.textContent = 'v' + chrome.runtime.getManifest().version;
const $ = id => document.getElementById(id);
let actionPending = false;
let generation = 0;
let lastState;
let apiCatalog = null;
let apiStartup = false;
let apiKeyConfigured = false;
function savedSelection(site) {try {return localStorage.getItem('bridge-' + site);} catch {return '';}}
function showError(error) {
  const message = error?.message || String(error);
  $('error').textContent = message;
  $('status').textContent = message;
}
async function request(path, data) {
  let timer;
  let body;
  try {
    body = await Promise.race([
      chrome.runtime.sendMessage({path: '/api/' + path, data}),
      new Promise((_, reject) => {timer = setTimeout(() => reject(Error('The extension is not answering. Reload the bridge at edge://extensions, then reopen these controls.')), path === 'play' ? 45000 : path.startsWith('api-') ? 30000 : 6000);})
    ]);
  } finally {clearTimeout(timer);}
  if (!body || body.error) throw Error(body?.error || 'Extension disconnected');
  return body;
}
function render(state) {
  if (!lastState && state.mode) $('mode').value = state.mode;
  lastState = state;
  if (state.running) $('mode').value = state.mode || 'direct';
  $('mode').disabled = state.running;
  const group = $('mode').value === 'group';
  const api = $('mode').value === 'api-room';
  $('group-help').hidden = !group;
  $('api-options').hidden = !api;
  $('nomi').closest('label').hidden = api;
  if (api && !apiStartup) { apiStartup = true; void loadApi(); }
  $('room-state').textContent = state.room ? `Auto Chat: ${state.room.autoChat} · ${state.room.userTurn ? 'Waiting for user turn' : 'No user-turn notice'} · Members: ${state.room.members.join(', ')}` : '';
  for (const site of ['chatgpt', 'nomi']) {
    const select = $(site);
    const old = select.value || savedSelection(site);
    const tabs = state.tabs.filter(tab => (group ? site === 'chatgpt' ? tab.site === 'chatgpt' : tab.room :
      api ? tab.site === 'chatgpt' : !tab.room));
    const options = tabs.map(tab => new Option(`${tab.room ? 'Nomi room' : tab.site === 'nomi' ? 'Nomi' : 'ChatGPT'} · ${tab.browser} · window ${tab.window} · ${tab.title || tab.url || tab.id}${tab.connected ? '' : ' — '+(tab.diagnostic || 'Connecting…')}`, tab.id));
    select.replaceChildren(new Option('Select a chat tab…', ''), ...options);
    if (tabs.some(tab => tab.id === old)) select.value = old;
    else {
      const other = site === 'nomi' ? $('chatgpt').value : $('nomi').value;
      const candidate = tabs.find(tab => tab.id !== other);
      if (candidate) select.value = candidate.id;
    }
    select.disabled = state.running;
  }
  $('first').disabled = state.running || group || api;
  if (api) $('first').value = 'first';
  $('settle').disabled = state.running;
  $('play').disabled = actionPending;
  $('play').textContent = state.running ? '▶ Running — check status' : '▶ Play';
  $('reset').disabled = state.running;
  for (const id of ['api-nomi','api-room','api-key','save-api-key','clear-api-key','refresh-api','api-room-name','create-api-room']) $(id).disabled = state.running;
  $('count').textContent = `${state.turns} messages forwarded`;
  $('status').textContent = state.reason;
  $('status').className = state.running ? 'running' : '';
  $('tabs').replaceChildren(...state.tabs.map(tab => {
    const row = document.createElement('p');
    row.textContent = `${tab.browser} · ${tab.site} · ${tab.title} — ${!tab.connected ? 'Disconnected' : tab.busy ? 'Generating a reply…' : tab.diagnostic || 'Connected'}`;
    return row;
  }));
  if (!state.tabs.length) $('tabs').textContent = 'Open a ChatGPT or Nomi tab in this Edge profile. Available tabs appear automatically.';
  $('events').replaceChildren(...state.events.slice(-12).reverse().map(event => {
    const row = document.createElement('li'); row.textContent = `${event.time}  ${event.text}`; return row;
  }));
}
async function action(name, data = {}) {
  if (actionPending && name !== 'stop') return;
  const current = ++generation;
  actionPending = true;
  $('play').disabled = true;
  $('error').textContent = '';
  $('status').textContent = name === 'play' ? 'Starting…' : name === 'stop' ? 'Stopping…' : 'Checking bridge…';
  try {const result = await request(name, data); if (current === generation) render(result);}
  catch (error) {if (current === generation) showError(error);}
  finally {if (current === generation) {actionPending = false; $('play').disabled = false;}}
}
$('play').onclick = () => {
  if (lastState?.running) {action('state'); return;}
  const api = $('mode').value === 'api-room';
  const roomId = $('api-room').value;
  const data = {mode: $('mode').value,
    tabs: [$('chatgpt').value, api ? 'api:room:' + roomId : $('nomi').value],
    first: api ? 'first' : $('first').value, settle: $('settle').value,
    ...(api ? {nomiUuid:$('api-nomi').value} : {})};
  if (api && (!apiKeyConfigured || !data.nomiUuid || !roomId)) {
    showError(Error('Save the Nomi API key, select one Nomi, and choose or create an API room.'));return;
  }
  if (!data.tabs[0] || !data.tabs[1]) {showError(Error('Select both chat tabs above. If a chat is missing, refresh that tab in Edge.')); return;}
  if (data.tabs[0] === data.tabs[1]) {showError(Error('Select two different chat tabs.')); return;}
  for (const [index, site] of ['chatgpt', 'nomi'].entries()) {
    if (api && site === 'nomi') continue;
    try {localStorage.setItem('bridge-' + site, data.tabs[index]);} catch { /* Saving a selection must not prevent Play. */ }
  }
  action('play', data);
};
$('stop').onclick = () => action('stop');
$('mode').onchange = () => {if (lastState) render(lastState);};
function apiRoomOptions(desiredRoom = '') {
  const id = $('api-nomi').value;
  const old = desiredRoom || $('api-room').value;
  const rooms = (apiCatalog?.rooms || []).filter(r => r.nomiUuids.includes(id));
  $('api-room').replaceChildren(new Option('Choose an API room…',''), ...rooms.map(r => new Option(r.name,r.uuid)));
  if (rooms.some(r=>r.uuid===old)) $('api-room').value=old;
  else if (rooms.length) $('api-room').value=rooms[0].uuid;
}
async function loadApi() {
  try {
    const config = await request('api-config');
    apiKeyConfigured = !!config.configured;
    $('api-key-status').textContent = apiKeyConfigured ? 'Saved on this Edge profile' : 'Not configured';
    if (!apiKeyConfigured) {
      apiCatalog=null;
      $('api-status').textContent='Save the key to list Nomis and persistent rooms.';
      return;
    }
    const oldNomi=$('api-nomi').value;
    const oldRoom=$('api-room').value;
    apiCatalog=await request('api-catalog');
    $('api-nomi').replaceChildren(new Option('Choose a Nomi…',''),...(apiCatalog.nomis||[]).map(n=>new Option(n.name,n.uuid)));
    if (apiCatalog.nomis.some(n=>n.uuid===oldNomi)) $('api-nomi').value=oldNomi;
    else if (apiCatalog.nomis.length) $('api-nomi').value=apiCatalog.nomis[0].uuid;
    apiRoomOptions(oldRoom);
    $('api-status').textContent='Found '+apiCatalog.nomis.length+' Nomis and '+apiCatalog.rooms.length+' API rooms. Only rooms belonging to the selected Nomi are offered.';
  } catch(error) { $('api-status').textContent=error.message; }
}
$('api-nomi').onchange=()=>apiRoomOptions();
$('refresh-api').onclick=()=>void loadApi();
$('save-api-key').onclick=async()=>{
  try {
    const key=$('api-key').value;
    await request('nomi-key',{key});
    $('api-key').value='';
    await loadApi();
  } catch(error) {$('api-status').textContent=error.message;}
};
$('clear-api-key').onclick=async()=>{
  try {
    await request('clear-nomi-key');
    $('api-key').value='';
    await loadApi();
  } catch(error) {$('api-status').textContent=error.message;}
};
$('create-api-room').onclick=async()=>{
  const nomiUuid=$('api-nomi').value;
  const nomi=apiCatalog?.nomis.find(n=>n.uuid===nomiUuid);
  if (!nomi) {$('api-status').textContent='Select a Nomi first.';return;}
  const name=$('api-room-name').value.trim() || 'WORLD::'+nomi.name;
  $('create-api-room').disabled=true;
  try {
    const created=await request('api-create-room',{nomiUuid,name});
    await loadApi();
    apiRoomOptions(created.roomUuid);
    $('api-room-name').value='';
    $('api-status').textContent='Created a persistent world room for '+nomi.name+'.';
  } catch(error) {$('api-status').textContent=error.message;}
  finally {$('create-api-room').disabled=!!lastState?.running;}
};
$('reset').onclick = () => action('reset');
let refreshing = false;
async function refresh() {
  if (refreshing || actionPending) return;
  const current = generation;
  refreshing = true;
  try {const result = await request('state'); if (!actionPending && current === generation) render(result);}
  catch (error) {if (!actionPending && current === generation) showError(error);}
  finally {refreshing = false;}
}
refresh(); setInterval(refresh, 1500);

$('copy-status').onclick = async () => {
  try {
    const state = await request('state');
    const report = {version: chrome.runtime.getManifest().version, mode: state.mode, room: state.room && {autoChat:state.room.autoChat,userTurn:state.room.userTurn,memberCount:state.room.members.length}, running: state.running, phase: state.phase, reason: state.reason,
      turns: state.turns, lastDelivery: state.lastDelivery, events: state.events, tabs: state.tabs.map(t => ({site:t.site, connected:t.connected, ready:t.ready,
        busy:t.busy, draft:t.draft, replyCharacters:t.reply?.length || 0, complete:t.complete, completion:t.completion, matches:t.matches, diagnostic:t.diagnostic}))};
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    $('copy-status').textContent = 'Copied — paste into our conversation';
  } catch (error) {$('error').textContent = error.message;}
};


