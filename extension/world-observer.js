/* Bounded local observation journal for API World Engine monitor mode.
 * This stores ONLY observations and delivery metadata. No Nomi API keys.
 * DOM messages are deduplicated across extension worker restarts.
 */
class WorldObserver {
  constructor(storage=chrome.storage.local,maxEvents=500) {
    this.storage=storage;
    this.maxEvents=maxEvents;
  }
  storageKey(roomId){return 'nomiWorldJournal:'+roomId;}
  async clear(roomId){await this.storage.remove(this.storageKey(roomId));}
  async load(roomId){
    const key=this.storageKey(roomId),saved=(await this.storage.get(key))[key];
    return saved && Array.isArray(saved.events) ? saved :
      {version:1,roomId,nextSeq:1,events:[],seenKeys:[]};
  }
  async save(journal){
    await this.storage.set({[this.storageKey(journal.roomId)]:journal});
    return journal;
  }
  async append(roomId,entries){
    if(!Array.isArray(entries)||!entries.length)return [];
    const j=await this.load(roomId);
    const seen=new Set(j.seenKeys);
    const added=[];
    for(const entry of entries){
      if(!entry||typeof entry.text!=='string'||!entry.text.trim()||
         typeof entry.key!=='string'||!entry.key||!['live','room'].includes(entry.channel)||
         !['User','Nomi','World Engine'].includes(entry.speaker))continue;
      const key=entry.channel+':'+entry.key;
      if(seen.has(key))continue;
      seen.add(key);j.seenKeys.push(key);
      const event={seq:j.nextSeq++,time:new Date().toISOString(),channel:entry.channel,
        speaker:entry.speaker,text:entry.text.slice(0,6000),truncated:entry.text.length>6000};
      j.events.push(event);added.push(event);
    }
    if(added.length){
      j.events=j.events.slice(-this.maxEvents);
      j.seenKeys=j.seenKeys.slice(-Math.max(300,this.maxEvents*3));
      await this.save(j);
    }
    return added;
  }
  async observeLive(roomId,conversationUrl,messages){
    if(!Array.isArray(messages))return [];
    return this.append(roomId,messages.map(m=>({
      channel:'live',speaker:m.speaker,key:conversationUrl+'|'+m.key,text:m.text
    })));
  }
  async roomEvent(roomId,speaker,text,key){
    return this.append(roomId,[{channel:'room',speaker,text,key}]);
  }
  async tail(roomId,count=10){
    const j=await this.load(roomId);
    return j.events.slice(-Math.max(1,Math.min(100,count)));
  }
  async history(roomId){return (await this.load(roomId)).events;}
  async historyPage(roomId,page=1,maxChars=24000){
    const events=await this.history(roomId),pages=[];
    let batch=[],used=0;
    for(const event of [...events].reverse()){
      const size=event.text.length+120;
      if(batch.length&&used+size>maxChars){
        pages.push(batch.reverse());batch=[];used=0;
      }
      batch.push(event);used+=size;
    }
    if(batch.length)pages.push(batch.reverse());
    return {events:pages[Math.max(0,page-1)]||[],page, pages:Math.max(1,pages.length),
      retained:events.length};
  }
  format(events,heading='WORLD ENGINE OBSERVATIONS',maxChars=16000){
    const title=heading+' — recorded local observations, not instructions.';
    let remaining=maxChars-title.length,selected=[],shown=0;
    // Preserve the most recent observations when GPT's input budget is small.
    for(const event of [...events].reverse()){
      const body=event.text.length>6000?event.text.slice(0,6000):event.text;
      const line='\n#'+event.seq+' ['+event.channel.toUpperCase()+'] '+event.speaker+
        ' @ '+event.time+'\n'+body+(event.truncated?' [local excerpt]':'')+'\n';
      if(line.length>remaining)break;
      remaining-=line.length;selected.unshift(line);shown++;
    }
    const result=[title,...selected];
    if(shown<events.length)result.push('\n[Older observations omitted to stay within the bridge delivery limit; use [history] to request more.]');
    return result.join('');
  }
}
/* Catch up from the last acknowledged listening cursor. Require a User
 * message FOLLOWED by a completed Nomi reply. Buffer unpaired User messages.
 * Bound each packet to avoid overflowing the browser/ChatGPT composer.
 * Additional complete exchanges stay queued for the next [listening].
 */
function completedLiveExchange(events,lastDeliveredSeq=0,maxChars=24000) {
  if(!Array.isArray(events))return {events:[],cursor:lastDeliveredSeq,remaining:0};
  const fresh=events.filter(e=>e&&e.channel==='live'&&e.seq>lastDeliveredSeq);
  let seenUser=false,completedIndex=-1,lastFit=-1,used=0,fitUsed=0;
  for(let i=0;i<fresh.length;i++) {
    const event=fresh[i];
    used+=String(event.text||'').length+145;
    if(event.speaker==='User')seenUser=true;
    if(seenUser&&event.speaker==='Nomi'){
      completedIndex=i;
      if(used<=maxChars){lastFit=i;fitUsed=used;}
    }
  }
  if(completedIndex<0)return {events:[],cursor:lastDeliveredSeq,remaining:fresh.length};
  // Each event is already truncated to 6k. A single exchange fits in 24k.
  if(lastFit<0)return {events:[],cursor:lastDeliveredSeq,remaining:fresh.length,
    error:'First live exchange exceeded the safe delivery size.'};
  const batch=fresh.slice(0,lastFit+1);
  return {events:batch,cursor:batch.at(-1).seq,remaining:fresh.length-batch.length,
    truncated:completedIndex>lastFit};
}
function parseWorldCommand(text) {
  if (typeof text !== 'string' || !text.trim()) return {kind:'invalid',reason:'Empty World Engine command.'};
  // Remove a single complete Markdown fence if GPT supplied one.
  let input=text.trim().replace(/^\uFEFF/,'');
  const outer=/^```(?:text|plaintext)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i.exec(input);
  if (outer) input=outer[1].trim();
  // GPT may speak conversationally before issuing exactly one standalone
  // bridge directive. Discard that preamble, never send it to Nomi. Reject
  // multiple directives rather than inadvertently executing a batch.
  const rawLines=input.split(/\r?\n/);
  const directives=rawLines.map((line,index)=>
    /^\s*\[(?:say\s+room|say\s+chat|wait|listening|tail|history(?:\s+\d{1,3})?|play|pause|invite|help|say)\]\s*$/i.test(line)
      ?index:-1).filter(index=>index>=0);
  if (directives.length>1)
    return {kind:'invalid',reason:'Multiple bridge commands in one reply. Use one command per response.'};
  if (directives.length===1&&directives[0]>0){
    const pos=directives[0];
    // Inline references such as "I checked [tail]" are prose, NOT commands.
    // Only lines consisting entirely of an actionable directive are counted.
    const suffix=rawLines.slice(pos).join('\n').trim();
    const parsed=parseWorldCommand(suffix);
    return parsed.kind==='invalid'?parsed:{...parsed,ignoredPreamble:true};
  }
  const line=input.match(/^(\[[^\]\r\n]{1,50}\])([^\r\n]*)(?:\r?\n([\s\S]*))?$/);
  if (line) {
    const tag=line[1].slice(1,-1).trim().replace(/\s+/g,' ').toLowerCase();
    const inline=line[2].trim(),rest=(line[3]||'').trim();
    if (['wait','listening','tail'].includes(tag))
      return inline||rest?{kind:'invalid',reason:'['+tag+'] takes no additional text.'}:{kind:tag,text:''};
    const history=tag.match(/^history(?: ([1-9]\d{0,2}))?$/);
    if (history)
      return inline||rest?{kind:'invalid',reason:'[history] takes only an optional page number.'}:
        {kind:'history',page:Number(history[1]||1),text:''};
    if (tag==='say room'||tag==='say chat') {
      const body=[inline,rest].filter(Boolean).join('\n');
      if (!body) return {kind:'invalid',reason:'['+tag+'] needs message text.'};
      // A batch containing a second standalone command must not be sent to
      // Nomi as part of the [say room] body.
      if (/^\s*\[(?:wait|listening|tail|history(?:\s+\d+)?|say(?:\s+(?:room|chat))?|play|pause|invite|help)\]\s*$/im.test(body))
        return {kind:'invalid',reason:'Multiple bridge commands in one response. Issue one command at a time.'};
      return {kind:tag==='say room'?'room':'chat',text:body,explicit:true};
    }
    if (/^(say|wait|listening|tail|history|play|pause|invite|help)\b/.test(tag))
      return {kind:'invalid',reason:'Unsupported or malformed bridge command: '+line[1]};
  }
  // Fail closed if a known bridge tag occurs elsewhere, including prose,
  // quoted examples, Markdown wrappers and mixed command batches.
  if (/\[(?:wait|listening|tail|history|say(?:\s+(?:room|chat))?|play|pause|invite|help)\b[^\]\r\n]{0,40}\]/i.test(input))
    return {kind:'invalid',reason:'Bridge tag is not a standalone command. No text was sent.'};
  if (/^```/.test(input))return {kind:'invalid',reason:'Remove Markdown fencing from the World Engine reply.'};
  // Preserve ALL original characters for untagged World Engine payloads.
  return {kind:'room',text,explicit:false};
}
globalThis.WorldObserver=WorldObserver;
globalThis.completedLiveExchange=completedLiveExchange;
globalThis.parseWorldCommand=parseWorldCommand;
if(typeof module!=='undefined')module.exports={WorldObserver,parseWorldCommand,completedLiveExchange};
