(() => {
  if (globalThis.__nomiBridgeLoaded) return;
  globalThis.__nomiBridgeLoaded = true;
  const bridgeAPI = globalThis.desktopBridgeChrome || globalThis.chrome;
  const site = /(^|\.)nomi\.ai$/.test(location.hostname) ? 'nomi' : 'chatgpt';
  const defaults = site === 'chatgpt' ? {
    replies: '[data-message-author-role="assistant"], [data-markdown-text-style="assistant-message"]',
    input: '#prompt-textarea, [data-composer-body] .ProseMirror[contenteditable="true"]',
    send: 'button[data-testid="send-button"], [data-composer-body] button[aria-label="Send"]',
    busy: 'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"]',
    verified: true
  } : {
    replies: '[class*="MessageBubble_nomiContent__"]:not([class*="blurredContent"])',
    input: 'textarea[aria-label="Chat Input"]',
    send: 'button[aria-label="Send message"]',
    busy: '[class*="NomiTypingBubble_messageWrapper__"]',
    verified: true
  };
  let config = defaults;
  let busy = false;
  let lastError = '';
  const documentId = crypto.randomUUID();
  const handled = new Set();
  const read = el => (el?.value ?? el?.innerText ?? '').trim();
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const enabled = el => !!el && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  function nodes(selector) {
    return selector ? [...document.querySelectorAll(selector)].filter(visible) : [];
  }
  function one(selector) {
    const matches = nodes(selector);
    return matches.length === 1 ? matches[0] : null;
  }
  async function load() {
    const value = await bridgeAPI.storage.local.get(site);
    config = {...defaults, ...value[site]};
    // Upgrade saved copies of the old built-in selectors; preserve custom setup.
    if (site === 'chatgpt') {
      const legacy = {replies: '[data-message-author-role="assistant"]', input: '#prompt-textarea', send: 'button[data-testid="send-button"]'};
      for (const key of Object.keys(legacy)) if (config[key] === legacy[key]) config[key] = defaults[key];
    }
  }
  function readReply(replies) {
    const last = replies.at(-1);
    if (site !== 'chatgpt') return {last, text: read(last), complete: true, completion: 'Nomi typing indicator and quiet time'};
    const modernTurn = last?.closest('[data-talvt-turn-state]');
    if (modernTurn) {
      const parts = [...modernTurn.querySelectorAll('[data-markdown-text-style="assistant-message"]')].filter(visible);
      const text = parts.map(read).filter(Boolean).join('\n\n');
      const complete = modernTurn.getAttribute('data-talvt-turn-state') === 'complete';
      return {last, text, complete, completion: complete ? 'ChatGPT turn marked complete' : 'Waiting for ChatGPT turn completion'};
    }
    // Completion controls must belong to this response, never an older turn.
    const turn = last?.closest('article[data-testid^="conversation-turn"], [data-testid^="conversation-turn-"], article');
    if (!turn) return {last, text: read(last), complete: false, completion: 'Cannot identify the current ChatGPT response container'};
    const parts = [...turn.querySelectorAll('[data-message-author-role="assistant"]')].filter(visible);
    const text = parts.length ? parts.map(read).filter(Boolean).join('\n\n') : read(last);
    const completedControl = [...turn.querySelectorAll('button[data-testid="copy-turn-action-button"], button[aria-label="Copy response"]')].some(visible);
    const streamingSelector = '.result-streaming, [data-is-streaming="true"], [aria-busy="true"]';
    const streaming = turn.matches(streamingSelector) || [...turn.querySelectorAll(streamingSelector)].some(visible);
    return {last, text, complete: completedControl && !streaming,
      completion: streaming ? 'ChatGPT response is streaming' : completedControl ? 'Completed response controls detected' : 'Waiting for ChatGPT completed-response controls'};
  }
  function snapshot() {
    try {
      const replies = nodes(config.replies);
      const {last, text, complete, completion} = readReply(replies);
      const messageId = last?.getAttribute('data-message-id') || last?.closest('[data-message-id]')?.getAttribute('data-message-id') || '';
      const input = one(config.input);
      const sends = nodes(config.send);
      const generating = nodes(config.busy).length > 0 || !!input?.disabled;
      return {
        site, title: document.title, url: location.href, document: documentId,
        reply: text, replyKey: `${replies.length}|${messageId}|${text}`,
        busy: generating, complete, completion,
        ready: !!config.verified && !!input && (sends.length === 1 || generating || (!read(input) && sends.length === 0)),
        draft: !!read(input), error: '',
        matches: replies.length,
        diagnostic: !config.verified ? 'Open extension setup and verify the Nomi selectors.' :
          !input ? 'Input selector must match exactly one visible editor.' :
          sends.length > 1 ? 'Send selector matches multiple visible buttons.' :
          !text ? 'No reply found yet. Send an opening message in this chat, or choose the other speaker first.' : 'Connected'
      };
    } catch (error) {
      return {site, title: document.title, url: location.href, document: documentId,
        ready: false, busy: false, error: `Selector error: ${error.message}`};
    }
  }
  async function api(path, data) {
    const result = await bridgeAPI.runtime.sendMessage({path, data});
    if (!result || result.error) throw Error(result?.error || 'Bridge disconnected');
    return result;
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function send(command) {
    if (handled.has(command.id)) return;
    // Claim once. A failed or lost acknowledgement never causes a second click.
    const check = snapshot();
    if (command.url !== location.href || command.document !== documentId) throw Error('Chat changed before send');
    if (!check.ready || check.busy || check.draft) throw Error('Chat not ready or contains a draft');
    handled.add(command.id);
    const claim = await api('/api/claim', {id: command.id});
    if (!claim.allowed) { handled.delete(command.id); return; }
    try {
      if (site === 'nomi' && command.text.length > 750) throw Error('Nomi messages are limited to 750 characters');
      const input = one(config.input);
      if (!input || read(input)) throw Error('Editor changed before send');
      if (input.maxLength > 0 && command.text.length > input.maxLength) throw Error('Reply exceeds the destination’s message length limit');
      input.focus();
      if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
        const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, command.text);
        input.dispatchEvent(new Event('input', {bubbles: true}));
        input.dispatchEvent(new Event('change', {bubbles: true}));
      } else if (input.isContentEditable) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(input);
        selection.removeAllRanges();
        selection.addRange(range);
        // Browser editing command preserves rich-editor state (e.g. ProseMirror).
        if (!document.execCommand('insertText', false, command.text)) throw Error('Editor rejected insertion');
      } else throw Error('Input is not an editable text field');
      // Rich editors may render paragraph separators and nonbreaking spaces
      // differently. Compare words/punctuation without changing the actual draft.
      const normalize = text => input.isContentEditable
        ? text.replace(/\s+/gu, ' ').trim()
        : text.replace(/\r\n/g, '\n').trim();
      let inserted = one(config.input);
      for (let attempt = 0; attempt < 10 && (!inserted || normalize(read(inserted)) !== normalize(command.text)); attempt++) {
        await sleep(100);
        inserted = one(config.input);
      }
      if (!inserted || normalize(read(inserted)) !== normalize(command.text)) throw Error(`Editor text differs from the reply (expected ${command.text.length} characters, read ${read(inserted).length}); message not submitted`);
      let button;
      for (let attempt = 0; attempt < 30; attempt++) {
        button = one(config.send);
        if (enabled(button)) break;
        await sleep(100);
      }
      if (!enabled(button)) throw Error('Send button did not become enabled');
      // Stop is checked again after editing and immediately before clicking.
      // A heartbeat cannot reissue a claimed command. Use a dedicated authorization check.
      const permit = await api('/api/claim', {id: command.id, checkOnly: true});
      if (!permit.allowed) throw Error('Stopped before submission; the draft was left in the editor');
      const currentInput = one(config.input);
      if (location.href !== command.url || !currentInput || normalize(read(currentInput)) !== normalize(command.text)) throw Error('Chat or draft changed before submission');
      // React may replace either element while the authorization request is pending.
      // Resolve the live button after the final await; never click a detached node.
      button = one(config.send);
      if (!enabled(button) || !button.isConnected) throw Error('Send button changed or became disabled before submission');
      button.click();
      for (let attempt = 0; attempt < 100; attempt++) {
        await sleep(100);
        const currentInput = one(config.input);
        if (currentInput && !read(currentInput)) {
          await api('/api/ack', {id: command.id});
          return;
        }
      }
      throw Error('The editor did not clear after Send; delivery is uncertain');
    } catch (error) {
      await api('/api/ack', {id: command.id, error: error.message});
    }
  }
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const result = await api('/api/heartbeat', {snapshot: snapshot()});
      lastError = '';
      if (result.command) await send(result.command);
    } catch (error) { lastError = error.message; }
    finally { busy = false; }
  }
  function candidateSelector(el) {
    for (const attr of ['data-message-author-role', 'data-testid', 'aria-label']) {
      if (el.hasAttribute(attr)) return `${el.localName}[${attr}=${JSON.stringify(el.getAttribute(attr))}]`;
    }
    if (el.id && !/\d{4}|:/.test(el.id)) return '#' + CSS.escape(el.id);
    const classes = [...el.classList].filter(c => !/^(hover|focus|active):/.test(c));
    if (classes.length) return el.localName + classes.map(c => '.' + CSS.escape(c)).join('');
    return el.localName;
  }
  function pick(field) {
    const banner = document.createElement('div');
    banner.textContent = `Bridge setup: click the ${field === 'replies' ? 'text of a Nomi reply (not your message)' : field} element. Escape cancels. Then reopen the extension to preview.`;
    Object.assign(banner.style, {position: 'fixed', top: '0', left: '0', right: '0', zIndex: '2147483647', background: '#163e35', color: 'white', padding: '18px', font: '16px sans-serif'});
    document.body.append(banner);
    const cleanup = () => {banner.remove(); document.removeEventListener('click', choose, true); document.removeEventListener('keydown', escape, true);};
    const escape = event => {if (event.key === 'Escape') cleanup();};
    const choose = async event => {
      if (event.target === banner) return;
      event.preventDefault(); event.stopImmediatePropagation();
      let element = event.target;
      if (field === 'send') element = element.closest('button, [role="button"]') || element;
      if (field === 'input') element = element.closest('textarea, input, [contenteditable="true"]') || element;
      config[field] = candidateSelector(element);
      config.verified = false;
      await bridgeAPI.storage.local.set({[site]: config});
      cleanup();
    };
    document.addEventListener('click', choose, true);
    document.addEventListener('keydown', escape, true);
  }
  bridgeAPI.runtime.onMessage.addListener((message, sender, reply) => {
    if (message.type === 'inspect') reply({site, config, snapshot: snapshot(), error: lastError});
    else if (message.type === 'wake') {tick(); reply({ok: true});}
    else if (message.type === 'pick') {pick(message.field); reply({ok: true});}
    else if (message.type === 'preview') {
      const original = config;
      try {config = {...config, ...message.config}; reply({snapshot: snapshot()});}
      finally {config = original;}
    }
  });
  bridgeAPI.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[site]) load().then(tick);
  });
  load().then(() => {tick(); setInterval(tick, 1000);});
})();


