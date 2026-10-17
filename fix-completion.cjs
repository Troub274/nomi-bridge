const fs=require('node:fs');
for (const p of ['browser_bridge/extension/engine.js','browser_bridge/extension/content.js','browser_bridge/tests/engine.test.cjs']) {
 let s=fs.readFileSync(p,'utf8').replaceAll('775','750').replaceAll('774','749');fs.writeFileSync(p,s);
}
const cp='browser_bridge/extension/content.js';let s=fs.readFileSync(cp,'utf8');
s=s.replace("    busy: 'button[data-testid=\"stop-button\"], button[aria-label=\"Stop generating\"]',", "    busy: 'button[data-testid=\"stop-button\"], button[aria-label=\"Stop generating\"], button[aria-label=\"Stop streaming\"]',");
s=s.replace('  function snapshot() {', `  function readReply(replies) {
    const last = replies.at(-1);
    if (site !== 'chatgpt') return {last, text: read(last), complete: true, completion: 'Nomi typing indicator and quiet time'};
    // Completion controls must belong to this response, never an older turn.
    const turn = last?.closest('article[data-testid^="conversation-turn"], [data-testid^="conversation-turn-"], article');
    if (!turn) return {last, text: read(last), complete: false, completion: 'Cannot identify the current ChatGPT response container'};
    const parts = [...turn.querySelectorAll('[data-message-author-role="assistant"]')].filter(visible);
    const text = parts.length ? parts.map(read).filter(Boolean).join('\\n\\n') : read(last);
    const completedControl = [...turn.querySelectorAll('button[data-testid="copy-turn-action-button"], button[aria-label="Copy response"]')].some(visible);
    const streaming = [...turn.querySelectorAll('.result-streaming, [data-is-streaming="true"], [aria-busy="true"]')].some(visible);
    return {last, text, complete: completedControl && !streaming,
      completion: streaming ? 'ChatGPT response is streaming' : completedControl ? 'Completed response controls detected' : 'Waiting for ChatGPT completed-response controls'};
  }
  function snapshot() {`);
s=s.replace("      const last = replies.at(-1);\n      const text = read(last);", "      const {last, text, complete, completion} = readReply(replies);");
s=s.replace('        busy: generating,','        busy: generating, complete, completion,');
fs.writeFileSync(cp,s);
const ep='browser_bridge/extension/engine.js';s=fs.readFileSync(ep,'utf8');
s=s.replace("old.busy !== snapshot.busy;", "old.busy !== snapshot.busy || old.complete !== snapshot.complete;");
s=s.replace("    if (!source.reply) {", "    if (source.complete === false) {this.reason = source.completion || ('Waiting for ' + speaker + ' to finish its response.'); return;}\n    if (!source.reply) {");
fs.writeFileSync(ep,s);
const pp='browser_bridge/extension/popup.js';s=fs.readFileSync(pp,'utf8');s=s.replace('Generating: ${snapshot.busy}\\n','Generating: ${snapshot.busy}\\nComplete: ${snapshot.complete}\\n${snapshot.completion || ""}\\n');fs.writeFileSync(pp,s);
const dp='browser_bridge/extension/dashboard.js';s=fs.readFileSync(dp,'utf8');s=s.replace('replyCharacters:t.reply?.length || 0, matches:t.matches, diagnostic:t.diagnostic','replyCharacters:t.reply?.length || 0, complete:t.complete, completion:t.completion, matches:t.matches, diagnostic:t.diagnostic');fs.writeFileSync(dp,s);
const mp='browser_bridge/extension/manifest.json';const m=JSON.parse(fs.readFileSync(mp,'utf8').replace(/^\uFEFF/,''));m.version='0.1.4';fs.writeFileSync(mp,JSON.stringify(m,null,2)+'\n');
