const fs = require('node:fs');
const p='browser_bridge/extension/engine.js';
let s=fs.readFileSync(p,'utf8');
s=s.replace('class Bridge {', `const NOMI_MESSAGE_LIMIT = 775;
function splitNomiMessage(text) {
  const chunks = [];
  let rest = text;
  while (rest.length > NOMI_MESSAGE_LIMIT) {
    let end = NOMI_MESSAGE_LIMIT;
    // Do not split a UTF-16 surrogate pair (for example an emoji).
    if (/[\\uD800-\\uDBFF]/.test(rest[end - 1]) && /[\\uDC00-\\uDFFF]/.test(rest[end])) end--;
    const boundary = rest.slice(0, end).search(/\\s+\\S*$/);
    if (boundary > end / 2) end = boundary + 1;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  if (rest) chunks.push(rest);
  return chunks;
}
class Bridge {`);
s=s.replace("baseline: null, turns: 0,", "baseline: null, pendingNomi: [], turns: 0,");
s=s.replace("this.phase = 'source'; this.command = null; this.baseline = null; this.turns = 0;", "this.phase = 'source'; this.command = null; this.baseline = null; this.pendingNomi = []; this.turns = 0;");
s=s.replace("this.phase = 'idle'; this.pair = null; this.command = null;", "this.phase = 'idle'; this.pair = null; this.command = null; this.pendingNomi = [];");
s=s.replace("const target = this.pair.find(id => id !== this.source);", "const continuingNomi = this.pendingNomi.length > 0;\n    const target = continuingNomi ? this.pair[1] : this.pair.find(id => id !== this.source);");
s=s.replace("    this.command = {id: crypto.randomUUID(), target, text: source.reply,", "    if (!continuingNomi && dest.site === 'nomi') this.pendingNomi = splitNomiMessage(source.reply);\n    const text = dest.site === 'nomi' ? this.pendingNomi[0] : source.reply;\n    this.command = {id: crypto.randomUUID(), target, text,");
s=s.replace("this.phase = 'send'; this.log(`Forwarding ${source.site} → ${dest.site}.`);", "this.phase = 'send'; this.log(continuingNomi ? 'Sending the next part to Nomi.' : `Forwarding ${source.site} → ${dest.site}.`);");
s=s.replace("      this.source = cmd.target; this.baseline = cmd.baseline; this.phase = 'reply';", "      if (this.tabs[tab].site === 'nomi') this.pendingNomi.shift();\n      this.source = cmd.target; this.baseline = cmd.baseline; this.phase = 'reply';");
s=s.replace('module.exports = {Bridge};', 'module.exports = {Bridge, splitNomiMessage};');
fs.writeFileSync(p,s);
const cp='browser_bridge/extension/content.js';
s=fs.readFileSync(cp,'utf8').replace("      const input = one(config.input);\n      if (!input || read(input))", "      if (site === 'nomi' && command.text.length > 775) throw Error('Nomi messages are limited to 775 characters');\n      const input = one(config.input);\n      if (!input || read(input))");
fs.writeFileSync(cp,s);
const mp='browser_bridge/extension/manifest.json';const m=JSON.parse(fs.readFileSync(mp,'utf8').replace(/^\uFEFF/,''));m.version='0.1.2';fs.writeFileSync(mp,JSON.stringify(m,null,2)+'\n');
