const WORLD_OBSERVER_BUILD = 'heartbeat-r1';
const versionLabel = document.getElementById('build-version');
if (versionLabel) versionLabel.textContent = 'v' + chrome.runtime.getManifest().version + ' · ' + WORLD_OBSERVER_BUILD;
const $ = id => document.getElementById(id);
try {
  $('heartbeat-text').value = localStorage.getItem('bridge-heartbeat-text') || 'Continue the task.';
  $('heartbeat-delay').value = localStorage.getItem('bridge-heartbeat-delay') || '10';
} catch {}
let actionPending = false;
let generation = 0;
let lastState;
let apiCatalog = null;
let apiStartup = false;
let apiKeyConfigured = false;
let recoveryCheckpoint = null;
let recoveryInProgress = false;
let apiNoteBaseline = '';
let apiEditorRoomId = '';
let apiManagementPending = false;
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
  if (!lastState && state.heartbeatSettings) {
    $('heartbeat-text').value=state.heartbeatSettings.text || '';
    $('heartbeat-delay').value=state.heartbeatSettings.delay ?? 10;
  }
  lastState = state;
  if (state.running) $('mode').value = state.mode || 'direct';
  $('mode').disabled = state.running;
  const group = $('mode').value === 'group';
  const api = $('mode').value === 'api-room';
  const pulse = $('mode').value === 'heartbeat';
  $('heartbeat-options').hidden = !pulse;
  $('heartbeat-text').disabled=state.running;
  $('heartbeat-delay').disabled=state.running;
  $('first').closest('label').hidden=pulse;
  $('group-help').hidden = !group;
  $('api-options').hidden = !api;
  $('nomi').closest('label').hidden = api || pulse;
  if(api){
    const monitor=$('api-monitor-tab'),old=monitor.value;
    const tabs=(state.tabs||[]).filter(t=>t.site==='nomi'&&!t.room);
    monitor.replaceChildren(new Option('Auto-detect selected Nomi when private chat opens',''),
      ...tabs.map(t=>new Option((t.title||t.url||t.id)+' · window '+(t.window||'?'),t.id)));
    if(tabs.some(t=>t.id===old))monitor.value=old;
    $('api-monitor-status').textContent=state.apiRoom?.monitorEnabled?
      state.apiRoom.monitorConnected?'Monitoring the Nomi private chat — API room reply requests suppressed.':
      'Waiting for a usable private chat; API room replies are enabled.':'Live monitor disabled; receiving Nomi room replies.';
  }
  if (api && !apiStartup) { apiStartup = true; void loadApi(); }
  $('room-state').textContent = state.room ? `Auto Chat: ${state.room.autoChat} · ${state.room.userTurn ? 'Waiting for user turn' : 'No user-turn notice'} · Members: ${state.room.members.join(', ')}` : '';
  for (const site of ['chatgpt', 'nomi']) {
    const select = $(site);
    const old = select.value || savedSelection(site);
    const tabs = state.tabs.filter(tab => (group ? site === 'chatgpt' ? tab.site === 'chatgpt' : tab.room :
      (api || pulse) ? tab.site === 'chatgpt' : !tab.room));
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
  $('first').disabled = state.running || group || api || pulse;
  if (api) $('first').value = 'first';
  $('settle').disabled = state.running;
  $('play').disabled = actionPending;
  $('play').textContent = state.running ? '▶ Running — check status' : '▶ Play';
  $('reset').disabled = state.running;
  for (const id of ['api-nomi','api-room','api-key','save-api-key','clear-api-key','refresh-api','api-room-name','api-new-room-description','create-api-room']) $(id).disabled = state.running;
  renderRecoveryButtons();
  renderRoomManagementButtons();
  $('api-clear-journal').disabled=state.running || apiManagementPending || recoveryInProgress;
  $('api-monitor-live').disabled=state.running;
  $('api-monitor-idle').disabled=state.running || !$('api-monitor-live').checked;
  $('api-monitor-tab').disabled=state.running || !$('api-monitor-live').checked;
  $('count').textContent = `${state.turns} ${pulse ? 'heartbeats sent' : 'messages forwarded'}`;
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
  const pulse = $('mode').value === 'heartbeat';
  const roomId = $('api-room').value;
  const data = {mode: $('mode').value,
    tabs: pulse ? [$('chatgpt').value] : [$('chatgpt').value, api ? 'api:room:' + roomId : $('nomi').value],
    ...(pulse ? {heartbeatText:$('heartbeat-text').value,heartbeatDelay:Number($('heartbeat-delay').value)} : {}),
    first: api ? 'first' : $('first').value, settle: $('settle').value,
    ...(api ? {nomiUuid:$('api-nomi').value,
      monitorLive:$('api-monitor-live').checked,monitorTab:$('api-monitor-tab').value,
      monitorIdleSeconds:Number($('api-monitor-idle').value)||300} : {})};
  if (api && (!apiKeyConfigured || !data.nomiUuid || !roomId)) {
    showError(Error('Save the Nomi API key, select one Nomi, and choose or create an API room.'));return;
  }
  if (!data.tabs[0] || (!pulse && !data.tabs[1])) {showError(Error('Select both chat tabs above. If a chat is missing, refresh that tab in Edge.')); return;}
  if (data.tabs[0] === data.tabs[1]) {showError(Error('Select two different chat tabs.')); return;}
  for (const [index, site] of ['chatgpt', 'nomi'].entries()) {
    if ((api || pulse) && site === 'nomi') continue;
    try {localStorage.setItem('bridge-' + site, data.tabs[index]);} catch { /* Saving a selection must not prevent Play. */ }
  }
  if(pulse) try {
    localStorage.setItem('bridge-heartbeat-text',data.heartbeatText);
    localStorage.setItem('bridge-heartbeat-delay',String(data.heartbeatDelay));
  } catch {}
  action('play', data);
};
$('stop').onclick = () => action('stop');
$('mode').onchange = () => {if (lastState) render(lastState);};
$('api-monitor-live').onchange=()=>{
  $('api-monitor-tab').disabled=!$('api-monitor-live').checked||!!lastState?.running;
  $('api-monitor-idle').disabled=!$('api-monitor-live').checked||!!lastState?.running;
};
async function refreshJournalStatus(){
  const roomId=$('api-room').value;
  if(!roomId){$('api-journal-status').textContent='Select an API room to inspect local history.';return;}
  try{
    const state=await request('api-journal',{roomId});
    if(roomId===$('api-room').value)
      $('api-journal-status').textContent=(state.count||0)+' locally retained world/live events (latest 500).';
  }catch(e){$('api-journal-status').textContent=e.message;}
}
$('api-clear-journal').onclick=async()=>{
  const roomId=$('api-room').value;
  if(!roomId||lastState?.running||apiManagementPending)return;
  if(!window.confirm('Erase this room’s locally retained world and private-chat observations? The actual Nomi room and chat are unaffected.'))return;
  apiManagementPending=true;$('api-clear-journal').disabled=true;
  try{
    await request('api-clear-journal',{roomId});
    await refreshJournalStatus();
    $('api-status').textContent='Local world observation history cleared.';
  }catch(error){$('api-status').textContent=error.message;}
  finally{apiManagementPending=false;$('api-clear-journal').disabled=!!lastState?.running;}
};
function apiRoomOptions(desiredRoom = '') {
  const id = $('api-nomi').value;
  const old = desiredRoom || $('api-room').value;
  const rooms = (apiCatalog?.rooms || []).filter(r => r.nomiUuids.length===1 && r.nomiUuids[0]===id);
  $('api-room').replaceChildren(new Option('Choose an API room…',''), ...rooms.map(r => new Option(r.name,r.uuid)));
  if (rooms.some(r=>r.uuid===old)) $('api-room').value=old;
  else if (rooms.length) $('api-room').value=rooms[0].uuid;
  showRoomEditor(true);
}
function selectedApiRoom(){
  const id=$('api-room').value,nomiId=$('api-nomi').value;
  return (apiCatalog?.rooms||[]).find(r=>r.uuid===id&&r.nomiUuids.length===1&&r.nomiUuids[0]===nomiId)||null;
}
function renderRoomManagementButtons(){
  const inactive=!selectedApiRoom()||!!lastState?.running||apiManagementPending||recoveryInProgress;
  $('api-save-description').disabled=inactive;
  $('api-delete-room').disabled=inactive;
}
function showRoomEditor(force=false){
  const room=selectedApiRoom();
  $('api-room-editor').hidden=!room;
  if(!room){
    apiEditorRoomId='';apiNoteBaseline='';
    $('api-room-description').value='';
  }else if(force||apiEditorRoomId!==room.uuid){
    apiEditorRoomId=room.uuid;
    apiNoteBaseline=room.note||'';
    $('api-room-description').value=apiNoteBaseline;
  }
  renderRoomManagementButtons();
}
async function loadApi() {
  try {
    const config = await request('api-config');
    apiKeyConfigured = !!config.configured;
    $('api-key-status').textContent = apiKeyConfigured ? 'Saved on this Edge profile' : 'Not configured';
    if (!apiKeyConfigured) {
      apiCatalog=null;
      showRoomEditor(true);
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
    await loadCheckpoint();
    await refreshJournalStatus();
    $('api-status').textContent='Found '+apiCatalog.nomis.length+' Nomis and '+apiCatalog.rooms.length+' API rooms. Only single-Nomi rooms for the selected Nomi are offered.';
  } catch(error) { $('api-status').textContent=error.message; }
}
$('api-nomi').onchange=()=>{apiRoomOptions();void loadCheckpoint();};
$('api-room').onchange=()=>{showRoomEditor(true);void loadCheckpoint();void refreshJournalStatus();};
$('api-save-description').onclick=async()=>{
  const room=selectedApiRoom();
  if(!room||apiManagementPending||lastState?.running)return;
  const note=$('api-room-description').value;
  if(note.length>1000){$('api-status').textContent='Description is limited to 1,000 characters.';return;}
  if(note===apiNoteBaseline){$('api-status').textContent='Description is already saved.';return;}
  apiManagementPending=true;renderRoomManagementButtons();
  try{
    await request('api-update-room-note',{roomId:room.uuid,note,expectedNote:apiNoteBaseline});
    await loadApi();
    $('api-status').textContent='Updated the description for '+room.name+'. Backchanneling is unchanged.';
  }catch(error){
    $('api-status').textContent=error.message+' If the request timed out, refresh the room list to verify whether it was saved.';
  }finally{apiManagementPending=false;renderRoomManagementButtons();}
};
$('api-delete-room').onclick=async()=>{
  const room=selectedApiRoom();
  if(!room||apiManagementPending||lastState?.running)return;
  const answer=window.prompt('To permanently delete the Nomi API room, type its exact name:\\n'+room.name+'\\n\\nIts room history cannot be restored by the bridge.');
  if(answer===null)return;
  if(answer!==room.name){$('api-status').textContent='Room name did not match. Nothing was deleted.';return;}
  if(!window.confirm('Permanently delete '+room.name+' ('+room.uuid+')? This is irreversible and does not delete the Nomi herself.'))return;
  apiManagementPending=true;renderRoomManagementButtons();
  try{
    await request('api-delete-room',{roomId:room.uuid,nomiUuid:$('api-nomi').value,confirmName:answer});
    apiCatalog.rooms=apiCatalog.rooms.filter(r=>r.uuid!==room.uuid);
    apiRoomOptions();
    await loadApi();
    $('api-status').textContent='Deleted API room '+room.name+'. The Nomi herself remains.';
  }catch(error){
    $('api-status').textContent=error.message+' Deletion may be uncertain: refresh rooms before trying again.';
  }finally{apiManagementPending=false;renderRoomManagementButtons();}
};
function renderRecoveryButtons(){
  const cp=recoveryCheckpoint;
  const unsettled=cp && !['completed','abandoned'].includes(cp.status);
  $('api-recovery').hidden=!unsettled;
  const send=['planned','sending','paused','send_uncertain'].includes(cp?.status);
  const reply=['awaiting_reply','reply_not_ready','reply_uncertain','reply_received'].includes(cp?.status);
  $('api-recover-send').disabled=!send||!!lastState?.running||recoveryInProgress;
  $('api-recover-reply').disabled=!reply||!!lastState?.running||recoveryInProgress;
  $('api-abandon').disabled=!unsettled||!!lastState?.running||recoveryInProgress;
  if(!cp){$('api-recovery-state').textContent='No pending checkpoint.';return;}
  const uncertain=['send_uncertain','reply_uncertain'].includes(cp.status);
  $('api-recovery-state').textContent='Status: '+cp.status+' · Confirmed '+cp.confirmed+'/'+cp.total+
    ' content chunks · Attempted chunk '+(cp.attemptedIndex||'none')+
    (uncertain?' · Outcome unknown: explicit authorization risks a duplicate.':'');
}
async function loadCheckpoint(){
  const roomId=$('api-room').value;
  if(!roomId) {recoveryCheckpoint=null;renderRecoveryButtons();return;}
  try{
    const result=await request('api-checkpoint',{roomId});
    if(roomId!==$('api-room').value)return;
    recoveryCheckpoint=result.checkpoint;
    renderRecoveryButtons();
  }catch(error){$('api-recovery-state').textContent=error.message;}
}
async function recoverApi(kind){
  const cp=recoveryCheckpoint;
  const nomiUuid=$('api-nomi').value,roomId=$('api-room').value,chatgptTab=$('chatgpt').value;
  if(!cp||!roomId||!nomiUuid||!chatgptTab){$('api-status').textContent='Choose the original ChatGPT conversation, Nomi, and API room.';return;}
  const duplicate=kind==='send'&&cp.status==='send_uncertain'||kind==='reply'&&cp.status==='reply_uncertain';
  const warning=duplicate
    ? 'This POST may already have succeeded. Recovering may duplicate one room chunk or one Nomi reply. Have you inspected the room and explicitly authorized that risk?'
    : 'Resume the confirmed checkpoint without resending previously confirmed room chunks?';
  if(!window.confirm(warning))return;
  recoveryInProgress=true;renderRecoveryButtons();
  try{
    const result=await request(kind==='send'?'api-recover-send':'api-recover-reply',{
      roomId,nomiUuid,chatgptTab,
      monitorLive:$('api-monitor-live').checked,
      monitorTab:$('api-monitor-tab').value,
      monitorIdleSeconds:Number($('api-monitor-idle').value)||300
    });
    if(!result.started)throw Error('Recovery did not start.');
    $('api-status').textContent='Recovery requested. Watch the checkpoint and Activity panel for progress.';
  }catch(error){$('api-status').textContent=error.message;}
  finally{recoveryInProgress=false;renderRecoveryButtons();}
}
$('api-recover-send').onclick=()=>void recoverApi('send');
$('api-recover-reply').onclick=()=>void recoverApi('reply');
$('api-abandon').onclick=async()=>{
  const cp=recoveryCheckpoint;
  if(!cp||!window.confirm('Abandon this local checkpoint? Sent content remains in the Nomi room. Recovery will no longer be possible from this checkpoint.'))return;
  recoveryInProgress=true;renderRecoveryButtons();
  try{
    await request('api-abandon',{roomId:$('api-room').value});
    await loadCheckpoint();
    $('api-status').textContent='Checkpoint abandoned locally. Previously sent Nomi room content is unchanged.';
  }catch(error){$('api-status').textContent=error.message;}
  finally{recoveryInProgress=false;renderRecoveryButtons();}
};
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
  const note=$('api-new-room-description').value;
  if(note.length>1000){$('api-status').textContent='New room description is limited to 1,000 characters.';return;}
  $('create-api-room').disabled=true;
  try {
    const created=await request('api-create-room',{nomiUuid,name,note});
    await loadApi();
    apiRoomOptions(created.roomUuid);
    await loadCheckpoint();
    $('api-room-name').value='';
    $('api-new-room-description').value='';
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
  try {const result = await request('state'); if (!actionPending && current === generation) render(result);
    if ($('mode').value==='api-room' && !$('api-options').hidden && !recoveryInProgress && $('api-room').value)
      await loadCheckpoint();
  }
  catch (error) {if (!actionPending && current === generation) showError(error);}
  finally {refreshing = false;}
}
refresh(); setInterval(refresh, 1500);

$('copy-status').onclick = async () => {
  try {
    const state = await request('state');
    const report = {version: chrome.runtime.getManifest().version, observerBuild: WORLD_OBSERVER_BUILD, mode: state.mode,
      apiRoom: state.apiRoom && {nomiName:state.apiRoom.nomiName, effectiveMode:state.apiRoom.effectiveMode,
        monitorEnabled:state.apiRoom.monitorEnabled, monitorConnected:state.apiRoom.monitorConnected,
        monitorCount:state.apiRoom.monitorCount, monitorIdleSeconds:state.apiRoom.monitorIdleSeconds,
        pendingReply:state.apiRoom.pendingReply, listenRequestPending:state.apiRoom.listenRequestPending,
        lastDeliveredSeq:state.apiRoom.lastDeliveredSeq,
        pendingDeliverySeq:state.apiRoom.pendingDeliverySeq,
        roomReplyRequests:state.apiRoom.roomReplyRequests,
        replyAttemptsInTurn:state.apiRoom.replyAttemptsInTurn,
        replyLastErrorType:state.apiRoom.replyLastErrorType,
        replyLastHttpStatus:state.apiRoom.replyLastHttpStatus,
        replyNextRetrySeconds:state.apiRoom.replyNextRetrySeconds,
        replyWaitStartedAt:state.apiRoom.replyWaitStartedAt},
      selectedGPTTab:state.pair?.[0]||null, waitingOnTab:state.source||null,
      tabRetry:state.tabRetry||null,
      room: state.room && {autoChat:state.room.autoChat,userTurn:state.room.userTurn,memberCount:state.room.members.length}, running: state.running, phase: state.phase, reason: state.reason,
      turns: state.turns, lastDelivery: state.lastDelivery, events: state.events, tabs: state.tabs.map(t => ({id:t.id,site:t.site, selectedGPT:t.id===state.pair?.[0],
        connected:t.connected, ready:t.ready,
        busy:t.busy, draft:t.draft, replyCharacters:t.reply?.length || 0, complete:t.complete, completion:t.completion, matches:t.matches, diagnostic:t.diagnostic}))};
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    $('copy-status').textContent = 'Copied — paste into our conversation';
  } catch (error) {$('error').textContent = error.message;}
};


