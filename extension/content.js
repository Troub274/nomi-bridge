(() => {
  if (globalThis.__nomiBridgeLoaded) return;
  globalThis.__nomiBridgeLoaded = true;
  const bridgeAPI = globalThis.desktopBridgeChrome || globalThis.chrome;
  const site = /(^|\.)nomi\.ai$/.test(location.hostname) ? 'nomi' : 'chatgpt';
  const isRoom = () => site === 'nomi' && /^\/group-chats\/\d+\/?$/.test(location.pathname);
  const roomSelectors = {
    replies: '[class*="GroupChatMessageBubble_nomiContent__"]',
    input: 'textarea[aria-label="Group Chat Input"]',
    send: 'button[aria-label="Send message"]',
    busy: '[class*="NomiTypingBubble_messageWrapper__"], [class*="TypingBubble"]', verified: true
  };
  const selectors = () => isRoom() ? roomSelectors : config;
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
  // Read-only view of the private Nomi conversation, including USER messages.
  // This is not a send hook. Unknown/ambiguous speakers are deliberately omitted.
  function liveConversationMessages() {
    if (site !== 'nomi' || isRoom()) return [];
    const selector=[
      '[class*="MessageBubble_nomiContent__"]',
      '[class*="MessageBubble_userContent__"]',
      '[class*="MessageBubble_humanContent__"]'
    ].join(', ');
    const occurrences = new Map();
    const messages=[];
    const fingerprint = value => {
      let hash=2166136261;
      for(let i=0;i<value.length;i++)hash=Math.imul(hash^value.charCodeAt(i),16777619)>>>0;
      return hash.toString(16)+'-'+value.length;
    };
    for(const node of nodes(selector)){
      const cls=String(node.className||'');
      const speaker=cls.includes('MessageBubble_nomiContent__')?'Nomi':
        /MessageBubble_(user|human)Content__/.test(cls)?'User':null;
      if(!speaker)continue;
      const text=read(node);
      if(!text)continue;
      const wrapper=node.closest('[data-message-id],[class*="MessageBubble_wrapper__"],[class*="MessageBubble_messageWrapper__"]');
      const id=node.getAttribute('data-message-id')||wrapper?.getAttribute('data-message-id')||'';
      const keyBase=JSON.stringify([speaker,fingerprint(text)]);
      const occurrence=(occurrences.get(keyBase)||0)+1;
      occurrences.set(keyBase,occurrence);
      messages.push({speaker,text,key:id||keyBase+'|'+occurrence});
    }
    return messages.slice(-50);
  }
  function snapshot() {
    try {
      const config = selectors();
      const replies = nodes(config.replies);
      const {last, text, complete, completion} = readReply(replies);
      const messageId = last?.getAttribute('data-message-id') || last?.closest('[data-message-id]')?.getAttribute('data-message-id') || '';
      const input = one(config.input);
      const sends = nodes(config.send);
      const generating = nodes(config.busy).length > 0 || !!input?.disabled;
      const observed = site === 'nomi' && !isRoom() ? liveConversationMessages() : [];
      const liveMessages = generating && observed.at(-1)?.speaker === 'Nomi'
        ? observed.slice(0,-1) : observed;
      return {
        ...(isRoom() ? roomSnapshot() : site === 'nomi' ? {liveMessages} : {}),
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
  function roomSnapshot() {
    const counts = new Map();
    const messages = nodes('[class*="GroupChatMessageBubble_wrapper__"]').map(wrapper => {
      const speaker = wrapper.querySelector('[class*="GroupChatMessageBubble_nomiNameWrapper__"]')?.textContent?.trim() || 'User';
      const text = read(wrapper.querySelector('[class*="GroupChatMessageBubble_content__"]'));
      const key = JSON.stringify([speaker, text]);
      const occurrence = (counts.get(key) || 0) + 1; counts.set(key, occurrence);
      return {speaker, text, occurrence};
    }).filter(m => m.text);
    const members = nodes('[class*="GroupChatMessageEditor_groupChatMembers__"] button').map(b => b.getAttribute('aria-label') || b.title || read(b));
    const button = one('button[aria-label="Auto Chat"]');
    const indicator = button?.parentElement.querySelector('.mantine-Indicator-indicator');
    const notice = nodes('.mantine-Popover-dropdown').some(n => n.textContent.includes("It's your turn to respond"));
    return {room: true, messages, members, roomKey: JSON.stringify(messages),
      autoChat: button ? button.getAttribute('data-variant') === 'primary' ? 'enabled' : 'paused' : 'unknown',
      userTurn: notice || indicator?.textContent.trim() === '0'};
  }
  async function api(path, data) {
    const result = await bridgeAPI.runtime.sendMessage({path, data});
    if (!result || result.error) throw Error(result?.error || 'Bridge disconnected');
    return result;
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function send(command) {
    if (command.groupCommand && command.action && command.action !== 'say') return roomAction(command);
    const config = selectors();
    if (handled.has(command.id)) return;
    // Claim once. A failed or lost acknowledgement never causes a second click.
    const check = snapshot();
    if (command.url !== location.href || command.document !== documentId) throw Error('Chat changed before send');
    if (!check.ready || check.busy || check.draft) throw Error('Chat not ready or contains a draft');
    handled.add(command.id);
    const claim = await api('/api/claim', {id: command.id});
    if (!claim.allowed) { handled.delete(command.id); return; }
    try {
      if (site === 'nomi' && command.text.length > 800) throw Error('Nomi messages are limited to 800 characters');
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
      if (command.groupCommand && command.action === 'say' && roomSnapshot().roomKey !== command.roomKey) throw Error('Room changed while composing; message was not submitted');
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
          if (command.groupCommand && command.action === 'say') {
            const current = snapshot();
            const latestUser = current.messages?.filter(m => m.speaker === 'User').at(-1);
            // Clearing the editor can precede React committing the new message.
            // Do not release the next batch action against the old room snapshot.
            if (current.roomKey === command.roomKey || latestUser?.text !== command.text.trim()) continue;
            await api('/api/ack', {id: command.id, snapshot: current});
          } else await api('/api/ack', {id: command.id});
          return;
        }
      }
      throw Error('Send did not confirm editor clearing and, for a room message, its appearance in the transcript; delivery is uncertain');
    } catch (error) {
      await api('/api/ack', {id: command.id, error: error.message});
    }
  }
  async function roomAction(command) {
    if (handled.has(command.id)) return;
    const check = snapshot();
    if (!isRoom() || command.url !== location.href || command.document !== documentId || check.busy || check.draft || !check.ready) throw Error('Room is not ready for this control');
    handled.add(command.id);
    const claim = await api('/api/claim', {id: command.id});
    if (!claim.allowed) {handled.delete(command.id); return;}
    try {
      const authorize = async () => {
        const permit = await api('/api/claim', {id: command.id, checkOnly: true});
        const current = snapshot();
        if (!permit.allowed || location.href !== command.url || current.draft || current.busy || current.roomKey !== command.roomKey) throw Error('Stopped or room changed before control action');
      };
      const autoButton = () => {
        const button = one('button[aria-label="Auto Chat"]');
        if (!enabled(button)) throw Error('Auto Chat button unavailable');
        return button;
      };
      if (command.action === 'invite') {
        await authorize();
        const matches = nodes('[class*="GroupChatMessageEditor_groupChatMembers__"] button').filter(b => (b.getAttribute('aria-label') || b.title || read(b)) === command.member);
        if (matches.length !== 1 || !enabled(matches[0])) throw Error('Member is missing, ambiguous, or unavailable');
        matches[0].click();
        let confirmed = false;
        for (let i = 0; i < 100; i++) {await sleep(100); const s = snapshot(); if (s.busy || s.roomKey !== command.roomKey) {confirmed = true; break;}}
        if (!confirmed) throw Error('No typing or new message detected after inviting member');
      } else if (command.action === 'pause' || command.action === 'play') {
        const initial = roomSnapshot();
        // At zero the UI is still enabled. Pause then resume replenishes Auto Chat.
        if (command.action === 'pause' ? initial.autoChat === 'enabled' : initial.autoChat === 'enabled' && initial.userTurn) {
          await authorize(); autoButton().click();
          for (let i = 0; i < 30 && roomSnapshot().autoChat !== 'paused'; i++) await sleep(100);
          if (roomSnapshot().autoChat !== 'paused') throw Error('Auto Chat did not pause');
        }
        if (command.action === 'play' && roomSnapshot().autoChat === 'paused') {
          await authorize(); autoButton().click();
          for (let i = 0; i < 30 && (roomSnapshot().autoChat !== 'enabled' || roomSnapshot().userTurn); i++) await sleep(100);
          if (roomSnapshot().autoChat !== 'enabled' || roomSnapshot().userTurn) throw Error('Auto Chat did not resume');
        }
        if (roomSnapshot().autoChat === 'unknown') throw Error('Cannot determine Auto Chat state');
      } else throw Error('Unsupported room control');
      await api('/api/ack', {id: command.id});
    } catch (error) {await api('/api/ack', {id: command.id, error: error.message});}
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
    if (message.type === 'inspect') reply({site, config: selectors(), snapshot: snapshot(), error: lastError});
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


