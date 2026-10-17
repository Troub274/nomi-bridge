/* Nomi API room driver: single Nomi, durable checkpoints, uploader-compatible recovery. */
class NomiApiDriver {
  constructor(getBridge,transaction,checkpoint=new ApiRoomCheckpoint()) {
    this.getBridge=getBridge;
    this.transaction=transaction;
    this.checkpoint=checkpoint;
    this.inFlight=false;
    this.waitCancelled=false;
  }
  delay(ms) { return new Promise(resolve=>setTimeout(resolve,ms)); }
  transient(error) {
    return error.httpStatus == null || [408,409,425,429,500,502,503,504].includes(error.httpStatus) ||
      ['RoomStillCreating','TooManyRequests','TimeoutError','URLError',
       'ConnectionResetError','RemoteDisconnected','NoReply','RoomNomiNotReadyForMessage'].includes(error.apiType);
  }
  notReady(error) {
    return error.httpStatus != null &&
      ['NoReply','RoomNomiNotReadyForMessage','RoomStillCreating','TooManyRequests'].includes(error.apiType);
  }
  async request(path,method='GET',body,options={}) {
    const {nomiApiKey}=await chrome.storage.local.get('nomiApiKey');
    if (!nomiApiKey) throw Error('Save a Nomi API key in API Room settings.');
    const attempts=method==='GET'?8:1;
    let delay=1000;
    for(let i=0;i<attempts;i++) {
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),115000);
      try {
        const response=await fetch(NomiApiRoom.NOMI_API_BASE+path,{
          method,headers:{Authorization:nomiApiKey,Accept:'application/json',
            ...(body===undefined?{}:{'Content-Type':'application/json'})},
          ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:controller.signal
        });
        const payload=await response.json().catch(()=>({}));
        if (!response.ok) {
          const error=Error(NomiApiRoom.safeNomiError(response.status,payload));
          error.apiType=payload?.error?.type || payload?.type || '';
          error.httpStatus=response.status;
          throw error;
        }
        return payload;
      } catch(err) {
        const error=err.name==='AbortError' ? Error('Nomi API request timed out; outcome uncertain.') : err;
        if(error!==err)error.httpStatus=null;
        if(method!=='GET' || !this.transient(error) || i===attempts-1)throw error;
        await this.delay(delay);delay=Math.min(delay*2,30000);
      } finally {clearTimeout(timer);}
    }
  }
  async configured() {return {configured:!!(await chrome.storage.local.get('nomiApiKey')).nomiApiKey};}
  async setKey(key) {
    key=String(key||'').trim();
    if(key.length<10||key.length>512)throw Error('Enter a valid Nomi API key.');
    await chrome.storage.local.set({nomiApiKey:key});return {configured:true};
  }
  async clearKey() {await chrome.storage.local.remove('nomiApiKey');return {configured:false};}
  async catalog() {
    const [n,r]=await Promise.all([this.request('/nomis'),this.request('/rooms')]);
    const nomis=(Array.isArray(n.nomis)?n.nomis:[])
      .filter(x=>NomiApiRoom.safeNomiId(x.uuid))
      .map(x=>({uuid:x.uuid,name:String(x.name||x.uuid)}));
    const rooms=(Array.isArray(r.rooms)?r.rooms:[])
      .filter(x=>NomiApiRoom.safeNomiId(x.uuid))
      .map(x=>({uuid:x.uuid,name:String(x.name||x.uuid),
        nomiUuids:['nomiUuids','nomis'].flatMap(k=>
          Array.isArray(x[k])?x[k].map(v=>typeof v==='string'?v:v?.uuid).filter(Boolean):[])}));
    return {nomis,rooms};
  }
  async waitForRoom(roomId,attempts=90) {
    for(let i=0;i<attempts;i++) {
      const room=await this.request('/rooms/'+roomId);
      const status=(room.room||room).status;
      if(status!=='Creating')return room;
      if(i===attempts-1)throw Error('Nomi API room remained in Creating state. Inspect room before continuing.');
      await this.delay(1000);
    }
  }
  async createRoom(nomiUuid,name) {
    if(!NomiApiRoom.safeNomiId(nomiUuid))throw Error('Select a Nomi.');
    name=String(name||'').trim();
    if(!name||name.length>80)throw Error('Room name must have 1–80 characters.');
    const catalog=await this.catalog();
    if(!catalog.nomis.some(n=>n.uuid===nomiUuid))throw Error('Selected Nomi not found.');
    // Room creation is non-idempotent: do NOT repeat an uncertain POST.
    const result=await this.request('/rooms','POST',{
      name,note:'Persistent world room for Chat Bridge API mode',
      backchannelingEnabled:true,nomiUuids:[nomiUuid]
    });
    const room=result.room||result;
    if(!NomiApiRoom.safeNomiId(room.uuid))
      throw Error('Room creation outcome uncertain: inspect rooms before creating another.');
    await this.waitForRoom(room.uuid);
    return {roomUuid:room.uuid};
  }
  snapshot(roomId,nomiName,old={},updates={}) {
    return {...old,site:'api-room',url:'api-room:'+roomId,
      document:NomiApiRoom.apiRoomId(roomId),title:'Nomi API room — '+nomiName,
      ready:true,busy:false,draft:false,error:'',complete:true,
      reply:old.reply||'',replyKey:old.replyKey||'',...updates};
  }
  touch() {
    const b=this.getBridge();if(b?.mode!=='api-room')return;
    const id=b.pair?.[1],tab=b.tabs[id];
    if(tab?.site==='api-room')tab.seen=b.clock();
  }
  async prepareStart(data) {
    const b=this.getBridge();
    if(this.inFlight)throw Error('An API operation is still in progress.');
    const roomId=NomiApiRoom.apiRoomUuid(data.tabs?.[1]);
    if(!NomiApiRoom.safeNomiId(roomId)||!NomiApiRoom.safeNomiId(data.nomiUuid))
      throw Error('Select one Nomi and one API room.');
    const cp=await this.checkpoint.load(roomId);
    if(cp && !['completed','abandoned'].includes(cp.status))
      throw Error('This room has an unfinished checkpoint ('+cp.status+'). Use API recovery controls before Play.');
    const catalog=await this.catalog();
    const nomi=catalog.nomis.find(n=>n.uuid===data.nomiUuid);
    const room=catalog.rooms.find(r=>r.uuid===roomId);
    if(!nomi||!room||!NomiApiRoom.roomHasNomi(room,nomi.uuid))
      throw Error('Selected room does not contain the selected Nomi. Refresh the room list.');
    await this.waitForRoom(roomId);
    const old=b.apiSession?.roomId===roomId&&b.apiSession?.nomiUuid===nomi.uuid?b.apiSession:null;
    b.apiSession=old||{roomId,nomiUuid:nomi.uuid,nomiName:nomi.name,roomName:room.name,pendingReply:'none',sequence:0};
    const id=NomiApiRoom.apiRoomId(roomId);
    b.heartbeat(id,this.snapshot(roomId,nomi.name,b.tabs[id]||{}));
  }
  publicState() {
    const s=this.getBridge()?.apiSession;
    return s?{roomName:s.roomName,nomiName:s.nomiName,pendingReply:s.pendingReply,progress:s.progress||null}:null;
  }
  async checkpointState(roomId) {
    if(!NomiApiRoom.safeNomiId(roomId))return {checkpoint:null};
    return {checkpoint:this.checkpoint.brief(await this.checkpoint.load(roomId))};
  }
  async fail(message) {
    await this.transaction(()=>{
      const b=this.getBridge();
      if(b?.mode!=='api-room')return;
      b.phase='uncertain';b.command=null;
      if(b.apiSession)b.apiSession.pendingReply='uncertain';
      b.stop(message+' Check the room checkpoint and authorize recovery; nothing was resent.');
    });
  }
  async verifiedSource(cp) {
    const info=await chrome.tabs.sendMessage(Number(cp.sourceTab),{type:'inspect'});
    const source=info?.snapshot;
    if(!source||source.url!==cp.sourceUrl||source.document!==cp.sourceDocument ||
      source.replyKey!==cp.sourceReplyKey||source.reply!==cp.text ||
      source.busy||source.complete===false)
      throw Error('The original ChatGPT reply changed. Cannot safely recover this checkpoint in another conversation.');
  }
  async sendChunks(cp,{mustRun=false}={}) {
    const chunks=NomiApiRoom.apiChunks(cp.text);
    if(chunks.length!==cp.total)throw Error('Chunk plan mismatch; recovery blocked.');
    if(cp.attemptedIndex!==null)throw Error('Uncertain chunk requires operator authorization before sending.');
    for(let i=cp.confirmed;i<cp.total;i++) {
      const b=this.getBridge();
      if(mustRun&&!b.running) {
        await this.checkpoint.mark(cp,'paused','operator_paused',{nextIndex:i+1});
        throw Error('Bridge stopped between chunks. Confirmed chunks were retained.');
      }
      await this.checkpoint.attempt(cp,i+1); // durable BEFORE any POST
      try {
        await this.request('/rooms/'+cp.roomId+'/chat','POST',{messageText:chunks[i]});
      } catch(error) {
        await this.checkpoint.mark(cp,'send_uncertain','send_uncertain',{index:i+1,errorType:error.apiType||'NetworkOrHttpError',httpStatus:error.httpStatus??null});
        throw error;
      }
      await this.checkpoint.confirm(cp,i+1); // durable AFTER acknowledged POST
      await this.transaction(()=>{
        const b=this.getBridge();
        if(b.apiSession?.roomId===cp.roomId) {
          b.apiSession.progress={total:cp.total,confirmed:cp.confirmed};
          if(b.command?.id===cp.turnId)b.command.created=b.clock();
          b.log('API room chunk '+cp.confirmed+'/'+cp.total+' confirmed.');
        }
      });
    }
    await this.checkpoint.mark(cp,'awaiting_reply','content_complete');
  }
  async requestReply(cp) {
    if(cp.confirmed!==cp.total||cp.attemptedIndex!==null)
      throw Error('Cannot request reply before all content posts are confirmed.');
    let delay=1000,tryNumber=0;
    while(true) {
      if(this.waitCancelled||!this.getBridge()?.running) {
        await this.checkpoint.mark(cp,'reply_not_ready','reply_wait_paused');
        throw Error('Reply waiting paused. Resume the confirmed reply request from Recovery.');
      }
      tryNumber++;
      await this.checkpoint.replyAttempt(cp);
      try {
        const text=NomiApiRoom.nomiReplyText(await this.request('/rooms/'+cp.roomId+'/chat/request',
          'POST',{nomiUuid:cp.nomiUuid}));
        await this.checkpoint.replyCommitted(cp);
        return text;
      } catch(error) {
        if(this.notReady(error)) {
          await this.checkpoint.mark(cp,'reply_not_ready','reply_not_ready',
            {attempt:tryNumber,errorType:error.apiType,httpStatus:error.httpStatus});
          await this.delay(delay);
          delay=Math.min(delay*2,30000);
          continue; // Same prompt in room; request a NEW reply only, never resend content.
        }
        await this.checkpoint.mark(cp,'reply_uncertain','reply_uncertain',
          {errorType:error.apiType||'NetworkOrHttpError',httpStatus:error.httpStatus??null});
        throw error;
      }
    }
  }
  async completeReply(cp,reply,startedFromRecovery=false) {
    await this.transaction(()=>{
      const b=this.getBridge(),s=b.apiSession;
      if(b.mode!=='api-room'||s?.roomId!==cp.roomId)return;
      const id=NomiApiRoom.apiRoomId(cp.roomId),prior=b.tabs[id]||{};
      s.pendingReply='none';delete s.progress;
      s.sequence=(s.sequence||0)+1;
      b.heartbeat(id,this.snapshot(cp.roomId,s.nomiName,prior,{
        busy:false,reply,replyKey:'api-'+cp.roomId+'-'+s.sequence
      }));
      if(startedFromRecovery) {
        b.phase='reply';b.command=null;b.source=id;
        b.baseline=prior.replyKey||'';b.startedWait=b.clock();
        b.running=true;
      }
      b.log('Nomi replied in API room.');
    });
  }
  async pump() {
    const b=this.getBridge();
    if(this.inFlight||!b?.running||b.mode!=='api-room')return;
    const s=b.apiSession,id=b.pair?.[1];
    if(!s||id!==NomiApiRoom.apiRoomId(s.roomId))return;
    const cmd=b.command;
    if(b.phase==='send'&&cmd?.target===id) {
      if(cmd.claimed)return;
      this.inFlight=true;this.waitCancelled=false;
      try {
        const info=await chrome.tabs.sendMessage(Number(cmd.source),{type:'inspect'});
        const verified=await this.transaction(()=>this.getBridge().validateSource(cmd.id,info?.snapshot));
        if(!verified)return;
        const cp=await this.checkpoint.begin({roomId:s.roomId,nomiUuid:s.nomiUuid,
          command:cmd,chunks:NomiApiRoom.apiChunks(cmd.text)});
        const allowed=await this.transaction(()=>this.getBridge().claim(id,cmd.id).allowed);
        if(!allowed)throw Error('Source changed after checkpoint creation; inspect checkpoint.');
        await this.sendChunks(cp,{mustRun:true});
        await this.transaction(()=>{
          const b=this.getBridge();
          b.acknowledge(id,{id:cmd.id});
          b.apiSession.pendingReply='ready';
          b.heartbeat(id,this.snapshot(s.roomId,s.nomiName,b.tabs[id],{busy:true}));
          b.log('All '+cp.total+' chunks confirmed; Nomi reply pending.');
        });
      } catch(error) {await this.fail('API room send halted: '+error.message);}
      finally {this.inFlight=false;queueMicrotask(()=>void this.pump());}
      return;
    }
    if(b.source===id&&s.pendingReply==='ready') {
      this.inFlight=true;this.waitCancelled=false;
      try {
        const cp=await this.checkpoint.load(s.roomId);
        if(!cp||cp.status!=='awaiting_reply')throw Error('Missing confirmed content checkpoint; refusing reply request.');
        await this.transaction(()=>{this.getBridge().apiSession.pendingReply='inflight';});
        const reply=await this.requestReply(cp);
        await this.completeReply(cp,reply);
      } catch(error) {await this.fail('API room reply halted: '+error.message);}
      finally {this.inFlight=false;queueMicrotask(()=>void this.pump());}
    }
  }
  stopWaiting() {this.waitCancelled=true;}
  async recover(roomId,kind) {
    if(this.inFlight)throw Error('API operation in progress. Stop and retry after it finishes.');
    const cp=await this.checkpoint.load(roomId);
    if(!cp)throw Error('No checkpoint exists for this room.');
    if(this.getBridge()?.running)throw Error('Stop the bridge before recovering.');
    const b=this.getBridge(),s=b?.apiSession;
    if(b?.mode!=='api-room'||s?.roomId!==roomId||s?.nomiUuid!==cp.nomiUuid ||
      b.pair?.[0]!==cp.sourceTab)
      throw Error('Reconnect the original ChatGPT tab and the same Nomi API room before recovery.');
    if(kind==='send') {
      if(cp.status==='send_uncertain'&&cp.attemptedIndex!==cp.confirmed+1)
        throw Error('Uncertain chunk index mismatch.');
      if(!['send_uncertain','planned','sending','paused'].includes(cp.status))
        throw Error('There is no unfinished content send to recover.');
    } else if(kind==='reply') {
      if(!['reply_uncertain','reply_not_ready','awaiting_reply'].includes(cp.status))
        throw Error('There is no unresolved reply request to recover.');
    } else throw Error('Unknown recovery type.');
    // Require the original exact source reply to still be present. No duplicate turn by accident.
    if(kind==='send')await this.verifiedSource(cp);
    this.inFlight=true;this.waitCancelled=false;
    try {
      if(kind==='send') {
        await this.checkpoint.recoverSend(cp,cp.confirmed+1);
        await this.sendChunks(cp,{mustRun:false});
      } else await this.checkpoint.recoverReply(cp);
      // A recovered content turn is already in Nomi's room; NEVER POST it again here.
      await this.transaction(()=>{
        const b=this.getBridge();
        b.apiSession.pendingReply='ready';
        b.source=NomiApiRoom.apiRoomId(roomId);
        b.phase='reply';
        b.command=null;
        b.running=true; // Release reply request, then next GPT turn.
        b.startedWait=b.clock();
      });
      const reply=await this.requestReply(cp);
      await this.completeReply(cp,reply,true);
      return {recovered:true,checkpoint:this.checkpoint.brief(cp)};
    } catch(error) {
      await this.fail('Recovery halted: '+error.message);
      throw error;
    } finally {this.inFlight=false;queueMicrotask(()=>void this.pump());}
  }
  async abandon(roomId) {
    if(this.inFlight||this.getBridge()?.running)throw Error('Stop active API operations first.');
    const cp=await this.checkpoint.load(roomId);
    if(!cp)throw Error('No checkpoint exists.');
    if(['completed','abandoned'].includes(cp.status))throw Error('No unresolved checkpoint to abandon.');
    await this.checkpoint.abandon(cp);
    const b=this.getBridge();
    if(b.mode==='api-room'&&b.apiSession?.roomId===roomId) {
      b.phase='idle';b.command=null;
      b.apiSession.pendingReply='none';delete b.apiSession.progress;
    }
    return {abandoned:true,checkpoint:this.checkpoint.brief(cp)};
  }
}
globalThis.NomiApiDriver=NomiApiDriver;
if(typeof module!=='undefined')module.exports={NomiApiDriver};
