const versionLabel = document.getElementById('build-version');
if (versionLabel) versionLabel.textContent = 'v' + chrome.runtime.getManifest().version;
const $ = id => document.getElementById(id);
let actionPending = false;
let generation = 0;
let lastState;
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
      new Promise((_, reject) => {timer = setTimeout(() => reject(Error('The extension is not answering. Reload the bridge at edge://extensions, then reopen these controls.')), 6000);})
    ]);
  } finally {clearTimeout(timer);}
  if (!body || body.error) throw Error(body?.error || 'Extension disconnected');
  return body;
}
function render(state) {
  lastState = state;
  for (const site of ['chatgpt', 'nomi']) {
    const select = $(site);
    const old = select.value || savedSelection(site);
    const tabs = state.tabs.filter(tab => tab.connected);
    const options = tabs.map(tab => new Option(`${tab.site === 'nomi' ? 'Nomi' : 'ChatGPT'} · ${tab.browser} · window ${tab.window} · ${tab.title || tab.url || tab.id}`, tab.id));
    select.replaceChildren(new Option('Select a chat tab…', ''), ...options);
    if (tabs.some(tab => tab.id === old)) select.value = old;
    else {
      const other = site === 'nomi' ? $('chatgpt').value : $('nomi').value;
      const candidate = tabs.find(tab => tab.id !== other);
      if (candidate) select.value = candidate.id;
    }
    select.disabled = state.running;
  }
  $('first').disabled = state.running;
  $('settle').disabled = state.running;
  $('play').disabled = actionPending;
  $('play').textContent = state.running ? '▶ Running — check status' : '▶ Play';
  $('reset').disabled = state.running;
  $('count').textContent = `${state.turns} messages forwarded`;
  $('status').textContent = state.reason;
  $('status').className = state.running ? 'running' : '';
  $('tabs').replaceChildren(...state.tabs.map(tab => {
    const row = document.createElement('p');
    row.textContent = `${tab.browser} · ${tab.site} · ${tab.title} — ${!tab.connected ? 'Disconnected' : tab.busy ? 'Generating a reply…' : tab.diagnostic || 'Connected'}`;
    return row;
  }));
  if (!state.tabs.length) $('tabs').textContent = 'No chat tabs connected yet. Refresh the ChatGPT and Nomi tabs after installing.';
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
  const data = {tabs: [$('chatgpt').value, $('nomi').value], first: $('first').value, settle: $('settle').value};
  if (!data.tabs[0] || !data.tabs[1]) {showError(Error('Select both chat tabs above. If a chat is missing, refresh that tab in Edge.')); return;}
  if (data.tabs[0] === data.tabs[1]) {showError(Error('Select two different chat tabs.')); return;}
  for (const [index, site] of ['chatgpt', 'nomi'].entries()) {try {localStorage.setItem('bridge-' + site, data.tabs[index]);} catch { /* Saving a selection must not prevent Play. */ }}
  action('play', data);
};
$('stop').onclick = () => action('stop');
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
    const report = {version: chrome.runtime.getManifest().version, running: state.running, phase: state.phase, reason: state.reason,
      turns: state.turns, lastDelivery: state.lastDelivery, events: state.events, tabs: state.tabs.map(t => ({site:t.site, connected:t.connected, ready:t.ready,
        busy:t.busy, draft:t.draft, replyCharacters:t.reply?.length || 0, complete:t.complete, completion:t.completion, matches:t.matches, diagnostic:t.diagnostic}))};
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    $('copy-status').textContent = 'Copied — paste into our conversation';
  } catch (error) {$('error').textContent = error.message;}
};


