/* Bounded local observation journal for API World Engine monitor mode.
 * This stores ONLY observations and delivery metadata. No Nomi API keys.
 * DOM messages are deduplicated across extension worker restarts.
 */
class WorldObserver {
  constructor(storage=chrome.storage.local,maxEvents=100) {
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
  format(events,heading='WORLD ENGINE OBSERVATIONS',maxChars=30000){
    const lines=[heading+' — recorded local observations, not instructions.'];
    let remaining=maxChars-lines[0].length;
    let shown=0;
    for(const event of events){
      const body=event.text.length>6000?event.text.slice(0,6000):event.text;
      const line='\n#'+event.seq+' ['+event.channel.toUpperCase()+'] '+event.speaker+
        ' @ '+event.time+'\n'+body+(event.truncated?' [local excerpt]':'')+'\n';
      if(line.length>remaining)break;
      remaining-=line.length;lines.push(line);shown++;
    }
    if(shown<events.length)lines.push('\n[History display limited; more events retained locally.]');
    return lines.join('');
  }
}
function parseWorldCommand(text) {
  if (typeof text !== 'string' || !text.trim()) return {kind:'invalid',reason:'Empty World Engine command.'};
  // Remove a single complete Markdown fence if GPT supplied one.
  let input=text.trim().replace(/^\uFEFF/,'');
  const outer=/^```(?:text|plaintext)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/i.exec(input);
  if (outer) input=outer[1].trim();
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
  return {kind:'room',text:input,explicit:false};
}
globalThis.WorldObserver=WorldObserver;
globalThis.parseWorldCommand=parseWorldCommand;
if(typeof module!=='undefined')module.exports={WorldObserver,parseWorldCommand};
