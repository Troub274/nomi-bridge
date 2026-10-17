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
  if(typeof text!=='string')return {kind:'invalid',text:''};
  const input=text.trim();
  const match=/^\[(listening|tail|history|wait|say room|say chat)\](?:\s*\n|\s*$)/i.exec(input);
  if(!match)return {kind:'room',text};
  const tag=match[1].toLowerCase(),body=input.slice(match[0].length);
  if(tag==='say room')return {kind:'room',text:body};
  if(tag==='say chat')return {kind:'chat',text:body};
  return {kind:tag,text:body};
}
globalThis.WorldObserver=WorldObserver;
globalThis.parseWorldCommand=parseWorldCommand;
if(typeof module!=='undefined')module.exports={WorldObserver,parseWorldCommand};
