/* Nomi room API adapter. Local key never enters ChatGPT, bridge state, or diagnostics. */
class NomiApiDriver {
  constructor(getBridge, transaction) {
    this.getBridge = getBridge;
    this.transaction = transaction;
    this.inFlight = false;
  }
  async request(path, method = 'GET', body) {
    const {nomiApiKey} = await chrome.storage.local.get('nomiApiKey');
    if (!nomiApiKey) throw Error('Save a Nomi API key in API Room settings.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 115000);
    try {
      const response = await fetch(NomiApiRoom.NOMI_API_BASE + path, {
        method,
        headers:{Authorization:nomiApiKey,Accept:'application/json',
          ...(body === undefined ? {} : {'Content-Type':'application/json'})},
        ...(body === undefined ? {} : {body:JSON.stringify(body)}),
        signal:controller.signal
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = Error(NomiApiRoom.safeNomiError(response.status,payload));
        error.apiType = payload?.error?.type || payload?.type || '';
        throw error;
      }
      return payload;
    } catch (error) {
      if (error.name === 'AbortError') throw Error('Nomi API request timed out; outcome uncertain.');
      throw error;
    } finally {clearTimeout(timer);}
  }
  async configured() {
    return {configured:!!(await chrome.storage.local.get('nomiApiKey')).nomiApiKey};
  }
  async setKey(key) {
    key = String(key || '').trim();
    if (key.length < 10 || key.length > 512) throw Error('Enter a Nomi API key.');
    await chrome.storage.local.set({nomiApiKey:key});
    return {configured:true};
  }
  async clearKey() {
    await chrome.storage.local.remove('nomiApiKey');
    return {configured:false};
  }
  async catalog() {
    const [n,r] = await Promise.all([this.request('/nomis'),this.request('/rooms')]);
    const nomis = (Array.isArray(n.nomis) ? n.nomis : [])
      .filter(x => NomiApiRoom.safeNomiId(x.uuid))
      .map(x => ({uuid:x.uuid,name:String(x.name || x.uuid)}));
    const rooms = (Array.isArray(r.rooms) ? r.rooms : [])
      .filter(x => NomiApiRoom.safeNomiId(x.uuid))
      .map(x => ({uuid:x.uuid,name:String(x.name || x.uuid),
        nomiUuids:['nomiUuids','nomis'].flatMap(k =>
          Array.isArray(x[k]) ? x[k].map(v=>typeof v==='string'?v:v?.uuid).filter(Boolean):[])}));
    return {nomis,rooms};
  }
  async createRoom(nomiUuid,name) {
    if (!NomiApiRoom.safeNomiId(nomiUuid)) throw Error('Select a Nomi.');
    name = String(name || '').trim();
    if (!name || name.length > 80) throw Error('Room name must have 1–80 characters.');
    const catalog = await this.catalog();
    if (!catalog.nomis.some(n => n.uuid === nomiUuid)) throw Error('Selected Nomi not found.');
    const result = await this.request('/rooms','POST',{
      name,note:'Persistent world room for Chat Bridge API mode',
      backchannelingEnabled:true,nomiUuids:[nomiUuid]
    });
    const room = result.room || result;
    if (!NomiApiRoom.safeNomiId(room.uuid)) throw Error('Room may have been created but no ID was returned. Refresh the room list; do not retry blindly.');
    return {roomUuid:room.uuid};
  }
  snapshot(roomId,nomiName,old={},updates={}) {
    return {...old,site:'api-room',url:'api-room:' + roomId,
      document:NomiApiRoom.apiRoomId(roomId),title:'Nomi API room — ' + nomiName,
      ready:true,busy:false,draft:false,error:'',complete:true,
      reply:old.reply || '',replyKey:old.replyKey || '',...updates};
  }
  touch() {
    const bridge = this.getBridge();
    if (bridge?.mode !== 'api-room') return;
    const id=bridge.pair?.[1], tab=bridge.tabs[id];
    if (tab?.site === 'api-room') tab.seen=bridge.clock();
  }
  async prepareStart(data) {
    const bridge=this.getBridge();
    if (this.inFlight) throw Error('Nomi API request still in progress.');
    const roomId=NomiApiRoom.apiRoomUuid(data.tabs?.[1]);
    if (!NomiApiRoom.safeNomiId(roomId) || !NomiApiRoom.safeNomiId(data.nomiUuid)) throw Error('Select a Nomi and API room.');
    const catalog=await this.catalog();
    const nomi=catalog.nomis.find(n=>n.uuid===data.nomiUuid);
    const room=catalog.rooms.find(r=>r.uuid===roomId);
    if (!nomi || !room || !NomiApiRoom.roomHasNomi(room,nomi.uuid)) throw Error('Selected room does not contain that Nomi. Refresh the room list.');
    const previous=bridge.apiSession?.roomId===roomId && bridge.apiSession?.nomiUuid===nomi.uuid ? bridge.apiSession : null;
    bridge.apiSession=previous || {roomId,nomiUuid:nomi.uuid,nomiName:nomi.name,roomName:room.name,pendingReply:'none',sequence:0};
    const id=NomiApiRoom.apiRoomId(roomId);
    bridge.heartbeat(id,this.snapshot(roomId,nomi.name,bridge.tabs[id] || {}));
  }
  publicState() {
    const s=this.getBridge()?.apiSession;
    return s ? {roomName:s.roomName,nomiName:s.nomiName,pendingReply:s.pendingReply}:null;
  }
  async fail(message) {
    await this.transaction(()=>{
      const bridge=this.getBridge();
      if (bridge?.mode !== 'api-room') return;
      bridge.phase='uncertain';
      bridge.command=null;
      if (bridge.apiSession) bridge.apiSession.pendingReply='uncertain';
      bridge.stop(message+' Check the API room before Reset; nothing is resent automatically.');
    });
  }
  async reply(roomId,nomiUuid) {
    // Only explicit, unambiguous not-ready responses are retried.
    for (let i=0;i<6;i++) {
      try {
        return NomiApiRoom.nomiReplyText(await this.request('/rooms/'+roomId+'/chat/request','POST',{nomiUuid}));
      } catch(error) {
        if (!['NoReply','RoomNomiNotReadyForMessage','RoomStillCreating','TooManyRequests'].includes(error.apiType) || i===5) throw error;
        await new Promise(resolve=>setTimeout(resolve,Math.min(5000*(i+1),30000)));
      }
    }
  }
  async pump() {
    const bridge=this.getBridge();
    if (this.inFlight || !bridge?.running || bridge.mode!=='api-room') return;
    const session=bridge.apiSession,id=bridge.pair?.[1];
    if (!session || id!==NomiApiRoom.apiRoomId(session.roomId)) return;
    const cmd=bridge.command;
    if (bridge.phase==='send' && cmd?.target===id) {
      if (cmd.claimed) return; // Restored in-progress sends are not retried.
      this.inFlight=true;
      try {
        const info=await chrome.tabs.sendMessage(Number(cmd.source),{type:'inspect'});
        const allowed=await this.transaction(()=>{
          const b=this.getBridge();
          if (!b.validateSource(cmd.id,info?.snapshot)) return false;
          return b.claim(id,cmd.id).allowed;
        });
        if (!allowed) return;
        const chunks=NomiApiRoom.apiChunks(cmd.text);
        if (!chunks.length) throw Error('Empty ChatGPT reply cannot be sent.');
        for (const chunk of chunks) await this.request('/rooms/'+session.roomId+'/chat','POST',{messageText:chunk});
        await this.transaction(()=>{
          const b=this.getBridge();
          if (b.mode!=='api-room' || b.apiSession?.roomId!==session.roomId) return;
          b.acknowledge(id,{id:cmd.id});
          b.apiSession.pendingReply='ready';
          b.heartbeat(id,this.snapshot(session.roomId,session.nomiName,b.tabs[id],{busy:true}));
          b.log('Message committed to Nomi API room; reply pending.');
        });
      } catch(error) {await this.fail('API room send failed or outcome uncertain: '+error.message);}
      finally {this.inFlight=false; queueMicrotask(()=>void this.pump());}
      return;
    }
    if (bridge.source===id && session.pendingReply==='ready') {
      this.inFlight=true;
      try {
        const allowed=await this.transaction(()=>{
          const b=this.getBridge();
          if (!b.running || b.mode!=='api-room' || b.apiSession?.pendingReply!=='ready') return false;
          b.apiSession.pendingReply='inflight';
          b.log('Requesting Nomi reply in API room.');
          return true;
        });
        if (!allowed) return;
        const reply=await this.reply(session.roomId,session.nomiUuid);
        await this.transaction(()=>{
          const b=this.getBridge();
          if (b.mode!=='api-room' || b.apiSession?.roomId!==session.roomId) return;
          b.apiSession.pendingReply='none';
          b.apiSession.sequence=(b.apiSession.sequence||0)+1;
          b.heartbeat(id,this.snapshot(session.roomId,session.nomiName,b.tabs[id],{
            busy:false,reply,replyKey:'api-'+session.roomId+'-'+b.apiSession.sequence
          }));
          b.log('Nomi replied in API room.');
        });
      } catch(error) {await this.fail('Nomi reply request failed or outcome uncertain: '+error.message);}
      finally {this.inFlight=false; queueMicrotask(()=>void this.pump());}
    }
  }
}
globalThis.NomiApiDriver=NomiApiDriver;
if(typeof module!=='undefined')module.exports={NomiApiDriver};
