const fs=require('node:fs');const p='browser_bridge/extension/dashboard.js';let s=fs.readFileSync(p,'utf8');
s=s.replace("document.getElementById('build-version').textContent = 'v' + chrome.runtime.getManifest().version;", "const versionLabel = document.getElementById('build-version');\nif (versionLabel) versionLabel.textContent = 'v' + chrome.runtime.getManifest().version;");
s=s.replace("const $ = id => document.getElementById(id);", `const $ = id => document.getElementById(id);
let actionPending = false;
let generation = 0;
let lastState;
function savedSelection(site) {try {return localStorage.getItem('bridge-' + site);} catch {return '';}}
function showError(error) {
  const message = error?.message || String(error);
  $('error').textContent = message;
  $('status').textContent = message;
}`);
s=s.replace("  const body = await chrome.runtime.sendMessage({path: '/api/' + path, data});", `  let timer;
  let body;
  try {
    body = await Promise.race([
      chrome.runtime.sendMessage({path: '/api/' + path, data}),
      new Promise((_, reject) => {timer = setTimeout(() => reject(Error('The extension is not answering. Reload the bridge at edge://extensions, then reopen these controls.')), 6000);})
    ]);
  } finally {clearTimeout(timer);}`);
s=s.replace('function render(state) {','function render(state) {\n  lastState = state;');
s=s.replace("localStorage.getItem('bridge-' + site)","savedSelection(site)");
s=s.replace("function savedSelection(site) {try {return savedSelection(site);}","function savedSelection(site) {try {return localStorage.getItem('bridge-' + site);}");
s=s.replace("  $('play').disabled = state.running;", "  $('play').disabled = actionPending;\n  $('play').textContent = state.running ? '▶ Running — check status' : '▶ Play';");
const start=s.indexOf('async function action('),end=s.indexOf("$('stop').onclick",start);
s=s.slice(0,start)+`async function action(name, data = {}) {
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
  const data = {chatgpt: $('chatgpt').value, nomi: $('nomi').value, first: $('first').value, settle: $('settle').value};
  if (!data.chatgpt || !data.nomi) {showError(Error('Select both chat tabs above. If a chat is missing, refresh that tab in Edge.')); return;}
  for (const site of ['chatgpt', 'nomi']) {try {localStorage.setItem('bridge-' + site, data[site]);} catch { /* Saving a selection must not prevent Play. */ }}
  action('play', data);
};
`+s.slice(end);
s=s.replace('  if (refreshing) return;','  if (refreshing || actionPending) return;\n  const current = generation;');
s=s.replace("  try {render(await request('state'));}\n  catch { $('status').textContent = 'Extension disconnected. Reload this control page.'; }", "  try {const result = await request('state'); if (!actionPending && current === generation) render(result);}\n  catch (error) {if (!actionPending && current === generation) showError(error);}");
fs.writeFileSync(p,s);
p='browser_bridge/extension/dashboard.html';s=fs.readFileSync(p,'utf8').replace('<p id="error" role="alert"></p>','').replace('<p id="status" role="status">','<p id="error" role="alert"></p><p id="status" role="status">');fs.writeFileSync(p,s);
p='browser_bridge/extension/manifest.json';const m=JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));m.version='0.1.8';fs.writeFileSync(p,JSON.stringify(m,null,2)+'\n');
