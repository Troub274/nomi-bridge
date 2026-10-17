/* Pure turn engine. State is persisted in extension session storage by the worker. */
const NOMI_MESSAGE_LIMIT = 750;
const LENGTH_REMINDER = '\n\n[Bridge reminder: Your previous reply exceeded 750 characters and was truncated before Nomi received it. Keep your entire next reply and subsequent replies within 750 characters, including spaces and punctuation.]';
function limitNomiMessage(text) {
  if (text.length <= NOMI_MESSAGE_LIMIT) return text;
  let end = NOMI_MESSAGE_LIMIT;
  if (/[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return text.slice(0, end);
}
class Bridge {
  constructor(clock = () => Date.now() / 1000, saved = {}) {
    Object.assign(this, {tabs: {}, running: false, pair: null, source: null, phase: 'idle', command: null,
      baseline: null, remindChatGPT: false, lastDelivery: null, turns: 0, events: [], stableSeconds: 8, startedWait: 0,
      reason: 'Choose two tabs and press Play.'}, saved);
    this.clock = clock;
    if (saved.pendingNomi?.length) {
      this.running = false; this.phase = 'uncertain'; this.command = null;
      this.reason = 'Updated to one message per turn. Reset before continuing.';
    }
    delete this.pendingNomi;
  }
  log(text) {
    this.reason = text;
    this.events.push({time: new Date().toLocaleTimeString(), text});
    this.events = this.events.slice(-100);
  }
  stop(reason = 'Stopped. Press Play to resume.') {this.running = false; this.log(reason);}
  start(data) {
    if (this.running) throw Error('Already running. Stop before changing tabs.');
    if (this.phase === 'uncertain') throw Error('Delivery was uncertain. Check both chats, then Reset before starting again.');
    const pair = data.tabs || [data.chatgpt, data.nomi];
    if (!Array.isArray(pair) || pair.length !== 2 || !pair[0] || !pair[1] || pair[0] === pair[1]) throw Error('Select two different chat tabs.');
    pair.forEach(id => {
      const tab = this.tabs[id];
      if (!tab || !['chatgpt', 'nomi', 'api-room'].includes(tab.site) || this.clock() - tab.seen > 90) throw Error('Select two connected chat tabs.');
      if (!tab.ready) throw Error(tab.diagnostic || 'Open extension setup and check the chat controls.');
      if (tab.draft) throw Error('Clear the draft in both chats first.');
      if (tab.error) throw Error(tab.error);
    });
    if (JSON.stringify(this.pair) !== JSON.stringify(pair) || this.phase === 'idle') {
      this.pair = pair;
      this.source = pair[data.first === 'second' || (!data.tabs && data.first === 'nomi') ? 1 : 0];
      this.phase = 'source'; this.command = null; this.baseline = null; this.remindChatGPT = false; this.turns = 0;
    }
    const settle = Number(data.settle ?? 8);
    this.stableSeconds = Number.isFinite(settle) ? Math.max(3, Math.min(60, settle)) : 8;
    if (this.command && !this.command.claimed) this.command.created = this.clock();
    this.running = true; this.startedWait = this.clock();
    this.log('Running: waiting for a completed reply.'); this.tick();
  }
  reset() {
    if (this.running) throw Error('Stop before resetting.');
    this.phase = 'idle'; this.pair = null; this.command = null; this.remindChatGPT = false;
    this.log('Reset. Next Play starts with the selected speaker’s latest reply.');
  }
  heartbeat(id, snapshot) {
    const old = this.tabs[id];
    const changed = !old || old.replyKey !== snapshot.replyKey || old.reply !== snapshot.reply || old.busy !== snapshot.busy || old.complete !== snapshot.complete || old.roomKey !== snapshot.roomKey || old.autoChat !== snapshot.autoChat || old.userTurn !== snapshot.userTurn;
    this.tabs[id] = {...snapshot, id, seen: this.clock(), changed: changed ? this.clock() : old.changed};
    if (this.pair?.includes(id) && this.phase !== 'idle' && old && (old.url !== snapshot.url || old.document !== snapshot.document)) {
      // A harmless reload in API mode is NOT an uncertain Nomi API POST.
      // Never re-use the previous GPT answer after the page reload.
      if (this.mode === 'api-room' && old.url === snapshot.url && this.phase !== 'send') {
        if (this.source === id) {
          this.phase = 'reply';
          this.baseline = snapshot.replyKey;
          this.startedWait = this.clock();
        }
        this.log('Chat tab reloaded; retaining the API room and waiting for new complete activity.');
      } else {
        this.phase = 'uncertain';
        this.stop('Selected chat reloaded or navigated during a potentially active send. Inspect before Reset.');
      }
    } else if (this.running && this.pair?.includes(id) && snapshot.error) this.stop(snapshot.error);
    this.tick();
    if (this.running && this.phase === 'send' && this.command?.target === id && !this.command.claimed) return {command: {...this.command}};
    return {};
  }
  tick() {
    if (!this.running) return;
    const now = this.clock();
    if (this.pair.some(id => !this.tabs[id] || now - this.tabs[id].seen > 120)) {
      if (this.command?.claimed) {
        this.phase = 'uncertain';
        this.stop('A tab disconnected during Send. Check both chats, then Reset.');
      } else if(this.mode==='api-room') {
        // Private-chat observations and GPT replies are read opportunistically.
        // A background/sleeping tab must not kill the World Engine session:
        // resume naturally after its next heartbeat. Never re-send a claimed
        // command or override an uncertain delivery state.
        if(this.command && !this.command.claimed){
          this.command=null;
          this.phase='reply';
          this.baseline=this.tabs[this.source]?.replyKey||this.baseline;
        }
        this.reason='Waiting for a selected chat tab to reconnect. Play remains active; no Nomi API action attempted.';
      } else this.stop('A chat tab disconnected or went to sleep. Reopen it, then press Play.');
      return;
    }
    if (this.phase === 'send') {
      if (now - this.command.created > 90) {this.phase = 'uncertain'; this.stop('Send was not confirmed. Check both chats, then Reset. Nothing will be resent automatically.');}
      return;
    }
    // Waiting for live activity may intentionally be indefinite; silence is
    // not a reason to issue another Nomi API reply request or stop the bridge.
    if (this.mode === 'api-room' && this.apiSession?.pendingReply === 'live_wait') {
      this.reason = 'Listening for private-chat activity. No Nomi API reply requested.';
      return;
    }
    // The 15-minute idle watchdog belongs to browser chat relay modes.
    // The World Engine may legitimately wait for GPT or a private exchange
    // for hours. In API mode only in-flight sends use safety timeouts.
    if (this.mode !== 'api-room' && now - this.startedWait > 900) {
      this.stop('No completed reply for 15 minutes. Check the chat, then press Play to continue waiting.'); return;
    }
    const source = this.tabs[this.source];
    const speaker = ['nomi', 'api-room'].includes(source.site) ? 'Nomi' : 'ChatGPT';
    if (now - source.seen > 70) {this.reason = 'Waiting for ' + speaker + ' tab to reconnect.'; return;}
    if (source.busy) {this.reason = speaker + ' is still generating a reply.'; return;}
    if (source.complete === false) {this.reason = source.completion || ('Waiting for ' + speaker + ' to finish its response.'); return;}
    if (!source.reply) {this.reason = 'No ' + speaker + ' reply detected. Check its reply preview.'; return;}
    if (this.phase === 'reply' && source.replyKey === this.baseline) {
      // A completed API-room -> GPT delivery is not proof that GPT actually
      // generated its next turn. Surface this distinct failure mode rather
      // than presenting endless "listening" while new Nomi events accumulate.
      if (this.mode === 'api-room' && source.site === 'chatgpt' &&
          this.lastDelivery?.to === 'chatgpt' && now - this.startedWait >= 45) {
        const others=Object.entries(this.tabs).filter(([id,tab])=>
          id!==this.source&&tab.site==='chatgpt'&&now-tab.seen<90);
        this.reason='ChatGPT has not produced a NEW reply after the last bridge delivery ('+
          Math.floor(now-this.startedWait)+'s). Selected GPT tab: '+this.source+'. '+
          (others.length?'Other ChatGPT tabs are also connected; verify the correct tab is selected. ':'')+
          'The previous [listening] response was already delivered. No further private-chat messages will be forwarded until GPT explicitly issues another [listening].';
      } else this.reason='Waiting for a new '+speaker+' reply. The detected reply has not changed.';
      return;
    }
    if (now - source.changed < this.stableSeconds) {this.reason = 'Detected ' + speaker + ' reply; waiting for it to finish changing.'; return;}
    const target = this.pair.find(id => id !== this.source);
    const dest = this.tabs[target];
    const receiver = ['nomi', 'api-room'].includes(dest.site) ? 'Nomi' : 'ChatGPT';
    if (now - dest.seen > 70) {this.reason = 'Waiting for ' + receiver + ' tab to reconnect.'; return;}
    if (!dest.ready) {this.reason = receiver + ' cannot receive yet: ' + (dest.diagnostic || 'check its editor and Send button'); return;}
    if (dest.busy) {this.reason = 'Waiting for ' + receiver + ' to finish generating before sending.'; return;}
    if (dest.draft) {this.stop('The destination has a draft. Clear it, then press Play.'); return;}
    // Defense in depth: if the dashboard is accidentally in Direct mode,
    // do not leak API World Engine control tags to the Nomi private chat.
    if (dest.site === 'nomi' && this.mode !== 'group' &&
        /\[(?:tail|history|wait|listening|say\s+room|say\s+chat)\b[^\]]*\]/i.test(source.reply)) {
      this.stop('Bridge control tag blocked from Nomi private chat. Select API Room mode to use [tail], [history], [wait] or [say room].');
      return;
    }
    const includesReminder = dest.site === 'chatgpt' && this.remindChatGPT;
    const text = dest.site === 'nomi' ? limitNomiMessage(source.reply) : source.reply + (includesReminder ? LENGTH_REMINDER : '');
    const truncated = dest.site === 'nomi' && text.length < source.reply.length;
    if (truncated) this.log(speaker + ' reply shortened to 750 characters for Nomi.');
    this.command = {id: crypto.randomUUID(), target, text, truncated, includesReminder, url: dest.url, document: dest.document,
      claimed: false, created: now, baseline: dest.replyKey,
      source: this.source, sourceReply: source.reply, sourceKey: source.replyKey, sourceDocument: source.document, sourceUrl: source.url, previousPhase: this.phase};
    this.phase = 'send'; this.log(`Forwarding ${source.site} → ${dest.site}: read ${source.reply.length} characters; sending ${text.length}.`);
  }
  validateSource(id, snapshot) {
    const cmd = this.command;
    if (!cmd || cmd.id !== id || !this.running || this.phase !== 'send') return false;
    const valid = snapshot && !snapshot.error && !snapshot.busy && snapshot.complete !== false &&
      snapshot.reply === cmd.sourceReply && snapshot.replyKey === cmd.sourceKey &&
      snapshot.document === cmd.sourceDocument && snapshot.url === cmd.sourceUrl;
    if (valid) return true;
    if (cmd.claimed) {
      this.phase = 'uncertain';
      this.stop('The source reply changed before Send. Nothing further will be sent; check the draft and Reset.');
    } else {
      this.phase = cmd.previousPhase || 'reply'; this.command = null;
      if (snapshot && cmd.source) this.heartbeat(cmd.source, snapshot);
      this.reason = 'Reply changed or is still generating. Waiting for the complete reply.';
    }
    return false;
  }
  claim(tab, id, checkOnly = false) {
    const cmd = this.command;
    if (!this.running || this.phase !== 'send' || !cmd || cmd.id !== id || cmd.target !== tab) return {allowed: false};
    if (checkOnly) return {allowed: cmd.claimed};
    if (cmd.claimed) return {allowed: false};
    cmd.claimed = true; return {allowed: true};
  }
  acknowledge(tab, data) {
    const cmd = this.command;
    if (this.phase !== 'send' || !cmd || cmd.id !== data.id || cmd.target !== tab || !cmd.claimed) return {};
    if (data.error) {this.phase = 'uncertain'; this.stop(`Send stopped: ${data.error}. Check both chats, then Reset.`);}
    else {
      this.lastDelivery = {from: this.tabs[cmd.source]?.site, to: this.tabs[tab].site,
        readCharacters: cmd.sourceReply?.length, sentCharacters: cmd.text.length,
        truncated: !!cmd.truncated, reminderAdded: !!cmd.includesReminder};
      this.log('Send confirmed: ' + cmd.text.length + ' characters to ' + this.tabs[tab].site + '.');
      if (cmd.truncated && this.tabs[cmd.source]?.site === 'chatgpt') this.remindChatGPT = true;
      if (cmd.includesReminder) this.remindChatGPT = false;
      this.source = cmd.target; this.baseline = cmd.baseline; this.phase = 'reply';
      this.turns++; this.startedWait = this.clock();
      this.log(`${this.running ? 'Running' : 'Stopped'}: waiting for ${this.tabs[tab].site} to reply.`);
    }
    this.command = null; return {};
  }
  state() {
    this.tick();
    return {running: this.running, phase: this.phase, turns: this.turns, reason: this.reason, pair: this.pair,
      events: this.events, lastDelivery: this.lastDelivery, tabs: Object.values(this.tabs).filter(t => this.clock() - t.seen < 300)
        .map(t => ({...t, connected: this.clock() - t.seen < 90}))};
  }
  serialize() {const {clock, ...data} = this; return data;}
}
if (typeof module !== 'undefined') module.exports = {Bridge, limitNomiMessage};
else globalThis.Bridge = Bridge;

