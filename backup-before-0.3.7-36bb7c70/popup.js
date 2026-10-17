const $ = id => document.getElementById(id);
let tab, site;
const fields = ['replies', 'input', 'send', 'busy'];
async function message(data) {
  if (!tab) throw Error('Open this extension on a chat tab.');
  return chrome.tabs.sendMessage(tab.id, data);
}
function config() {return Object.fromEntries([...fields.map(field => [field, $(field).value.trim()]), ['verified', $('verified').checked]]);}
function show(snapshot) {
  $('result').textContent = `AI matches: ${snapshot.matches || 0}\nControls ready: ${snapshot.ready}\nGenerating: ${snapshot.busy}\nComplete: ${snapshot.complete}\n${snapshot.completion || ""}\n${snapshot.diagnostic || snapshot.error || ''}\n\nLATEST REPLY:\n${snapshot.reply || '(none)'}`;
}
async function run(fn) {try {await fn();} catch (error) {$('status').textContent = error.message + ' Refresh this chat tab if the extension was just installed.';}}
$('preview').onclick = () => run(async () => {show((await message({type: 'preview', config: config()})).snapshot);});
$('save').onclick = () => run(async () => {
  if (!site) throw Error('Open a chat tab first');
  const current = config();
  if (!current.busy || !current.replies || !current.input || !current.send) throw Error('All four selectors are required');
  await chrome.storage.local.set({[site]: current});
  $('status').textContent = 'Controls saved for ' + site + '.';
});
for (const button of document.querySelectorAll('[data-pick]')) button.onclick = () => run(async () => {await message({type: 'pick', field: button.dataset.pick}); window.close();});
run(async () => {
  [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  const info = await message({type: 'inspect'});
  site = info.site;
  $('site').textContent = 'Controls for ' + site;
  if (info.snapshot.room) {
    $('site').textContent = 'Nomi group room — automatic controls';
    $('save').disabled = true;
    for (const button of document.querySelectorAll('[data-pick]')) button.disabled = true;
    fields.forEach(field => $(field).disabled = true);
    $('verified').disabled = true;
  }
  fields.forEach(field => $(field).value = info.config[field]);
  $('verified').checked = !!info.config.verified;
  $('setup').open = !info.config.verified;
  show(info.snapshot);
  $('status').textContent = info.error || 'Tab connected to extension.';
});
