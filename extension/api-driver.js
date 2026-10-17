/* Nomi API room driver: single Nomi, durable checkpoints, uploader-compatible recovery. */
class NomiApiDriver {
  constructor(getBridge,transaction,checkpoint=new ApiRoomCheckpoint()) {
    this.getBridge=getBridge;
    this.transaction=transaction;
    this.checkpoint=checkpoint;
    this.inFlight=false;
    this.waitCancelled=false;
    this.recoveryScheduled=false;
    this.observer=new WorldObserver();
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
        note:typeof x.note==='string'?x.note:'',backchannelingEnabled:x.backchannelingEnabled===true,
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
  async createRoom(nomiUuid,name,note='Persistent world room for Chat Bridge API mode') {
    if(!NomiApiRoom.safeNomiId(nomiUuid))throw Error('Select a Nomi.');
    name=String(name||'').trim();
    if(!name||name.length>80)throw Error('Room name must have 1–80 characters.');
    if(typeof note!=='string'||note.length>1000)throw Error('Room description must be at most 1,000 characters.');
    const catalog=await this.catalog();
    if(!catalog.nomis.some(n=>n.uuid===nomiUuid))throw Error('Selected Nomi not found.');
    // Room creation is non-idempotent: do NOT repeat an uncertain POST.
    const result=await this.request('/rooms','POST',{
      name,note,
      backchannelingEnabled:true,nomiUuids:[nomiUuid]
    });
    const room=result.room||result;
    if(!NomiApiRoom.safeNomiId(room.uuid))
      throw Error('Room creation outcome uncertain: inspect rooms before creating another.');
    await this.waitForRoom(room.uuid);
    return {roomUuid:room.uuid};
  }
  ensureRoomManagementIdle() {
    if(this.inFlight||this.recoveryScheduled||this.getBridge()?.running)
      throw Error('Stop the bridge and any API recovery before managing rooms.');
  }
  async readRoom(roomId) {
    if(!NomiApiRoom.safeNomiId(roomId))throw Error('Select a valid API room.');
    const data=await this.request('/rooms/'+roomId);
    const room=data.room||data;
    if(room.uuid && room.uuid!==roomId)throw Error('Nomi API returned an unexpected room ID.');
    return room;
  }
  async updateRoomNote(roomId,note,expectedNote) {
    this.ensureRoomManagementIdle();
    if(typeof note!=='string'||note.length>1000)
      throw Error('Room description must be at most 1,000 characters.');
    if(typeof expectedNote!=='string')
      throw Error('Refresh room details before editing the description.');
    const room=await this.readRoom(roomId);
    if(typeof room.note!=='string')
      throw Error('Room description could not be read. Refresh and retry.');
    if(room.note!==expectedNote)
      throw Error('The room description changed elsewhere. Refresh before overwriting it.');
    if(room.note===note)return {updated:false,note};
    // Note-only PUT: do not reset backchanneling, membership, or room name.
    // An uncertain PUT must not be repeated automatically.
    await this.request('/rooms/'+roomId,'PUT',{note});
    const current=await this.readRoom(roomId);
    if(current.note!==note)
      throw Error('Nomi did not confirm the new room description. Refresh and inspect the room.');
    return {updated:true,note:current.note};
  }
  async deleteRoom(roomId,nomiUuid,confirmName) {
    this.ensureRoomManagementIdle();
    if(!NomiApiRoom.safeNomiId(roomId)||!NomiApiRoom.safeNomiId(nomiUuid))
      throw Error('Select a valid Nomi API room.');
    const cp=await this.checkpoint.load(roomId);
    if(cp&&!['completed','abandoned'].includes(cp.status))
      throw Error('Room has an unfinished checkpoint ('+cp.status+'). Recover or abandon the checkpoint first.');
    const catalog=await this.catalog();
    const listed=catalog.rooms.find(x=>x.uuid===roomId);
    if(!listed||listed.nomiUuids.length!==1||listed.nomiUuids[0]!==nomiUuid)
      throw Error('The selected room does not belong exclusively to the selected Nomi. Refresh rooms.');
    const room=await this.readRoom(roomId);
    if(room.name!==listed.name||typeof confirmName!=='string'||confirmName!==room.name)
      throw Error('Room deletion confirmation did not match its exact name.');
    // DELETE is irreversible; no retry after an uncertain outcome.
    await this.request('/rooms/'+roomId,'DELETE');
    // Only erase the local checkpoint after the server acknowledged deletion.
    await chrome.storage.local.remove(this.checkpoint.key(roomId));
    await this.observer.clear(roomId);
    const bridge=this.getBridge();
    if(bridge.apiSession?.roomId===roomId){
      bridge.apiSession=null;
      if(!bridge.running)bridge.reset();
      delete bridge.tabs[NomiApiRoom.apiRoomId(roomId)];
    }
    return {deleted:true,roomId,name:room.name};
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
    if(!nomi||!room||room.nomiUuids.length!==1||room.nomiUuids[0]!==nomi.uuid)
      throw Error('API Room mode requires a room containing exactly the selected Nomi and no other Nomis.');
    await this.waitForRoom(roomId);
    const old=b.apiSession?.roomId===roomId&&b.apiSession?.nomiUuid===nomi.uuid?b.apiSession:null;
    b.apiSession=old||{roomId,nomiUuid:nomi.uuid,nomiName:nomi.name,roomName:room.name,pendingReply:'none',sequence:0};
    const s=b.apiSession;
    s.monitorEnabled=!!data.monitorLive;
    s.monitorTabId=s.monitorEnabled?String(data.monitorTab||''):'';
    s.monitorSeen=0;s.monitorCount=0;s.monitorLastActivity=0;
    s.monitorIdleSeconds=Math.max(60,Math.min(3600,Number(data.monitorIdleSeconds)||300));
    s.monitorUrl='';
    s.monitorLastSeq=s.monitorLastSeq||0;
    s.monitorPendingSeq=0;
    s.monitorWorldStartSeq=0;
    s.listenDeadline=0;
    s.listenRequestPending=false;
    if(s.monitorEnabled&&s.monitorTabId){
      if(!/^\d+$/.test(s.monitorTabId))throw Error('Invalid Nomi private-chat tab ID.');
      const tab=await chrome.tabs.get(Number(s.monitorTabId));
      const url=tab?.url||'';
      if(!/^https:\/\/([a-z0-9-]+\.)?nomi\.ai\//i.test(url)||/\/group-chats\//.test(url))
        throw Error('The monitor tab must be a Nomi private conversation.');
      const embeddedUuid=/\/nomis\/([0-9a-f]{8}-[0-9a-f-]{27,})/i.exec(url);
      if(embeddedUuid&&embeddedUuid[1]!==nomi.uuid)
        throw Error('The chosen private-chat tab belongs to a different Nomi.');
      s.monitorUrl=url.split(/[?#]/)[0];
    }
    const id=NomiApiRoom.apiRoomId(roomId);
    b.heartbeat(id,this.snapshot(roomId,nomi.name,b.tabs[id]||{}));
  }
  publicState() {
    const s=this.getBridge()?.apiSession;
    return s?{roomName:s.roomName,nomiName:s.nomiName,pendingReply:s.pendingReply,progress:s.progress||null,
      monitorEnabled:!!s.monitorEnabled,monitorConnected:this.isLiveAvailable(s),
      effectiveMode:this.isLiveAvailable(s)?'live':'room-only',
      listenRequestPending:!!s.listenRequestPending,
      lastDeliveredSeq:s.monitorLastSeq||0,
      pendingDeliverySeq:s.monitorPendingSeq||0,
      monitorTab:s.monitorTabId||null,monitorCount:s.monitorCount||0,
      monitorIdleSeconds:s.monitorIdleSeconds||300,
      roomReplyRequests:s.roomReplyRequests||0,
      replyAttemptsInTurn:s.replyAttemptsInTurn||0,
      replyLastErrorType:s.replyLastErrorType||null,
      replyLastHttpStatus:s.replyLastHttpStatus??null,
      replyNextRetrySeconds:s.replyNextRetrySeconds??null,
      replyWaitStartedAt:s.replyWaitStartedAt||null}:null;
  }
  isLiveAvailable(s=this.getBridge()?.apiSession) {
    // The background wake alarm runs every 30 seconds. A background Nomi
    // tab must not oscillate between live and room-only between those wakes.
    return !!(s?.monitorEnabled&&s.monitorCount>0&&s.monitorSeen&&
      Date.now()-s.monitorSeen<75000&&s.monitorLastActivity&&
      Date.now()-s.monitorLastActivity<1000*(s.monitorIdleSeconds||300));
  }
  async observeLive(tabId,snapshot) {
    const b=this.getBridge(),s=b?.apiSession;
    if(b?.mode!=='api-room'||!s?.monitorEnabled)return;
    if(snapshot?.site!=='nomi'||/\/group-chats\//.test(snapshot.url||''))return;
    const currentUrl=(snapshot.url||'').split(/[?#]/)[0];
    if(!s.monitorTabId && (currentUrl.includes(s.nomiUuid) ||
      (s.monitorUrl&&currentUrl===s.monitorUrl)))
      s.monitorTabId=String(tabId);
    if(s.monitorTabId!==String(tabId))return;
    if(s.monitorUrl&&s.monitorUrl!==currentUrl){
      s.monitorSeen=0;s.monitorCount=0;return;
    }
    if(!s.monitorUrl)s.monitorUrl=currentUrl;
    const msgs=Array.isArray(snapshot.liveMessages)?snapshot.liveMessages:[];
    s.monitorSeen=Date.now();s.monitorCount=msgs.length;
    if(msgs.length){
      const added=await this.observer.observeLive(s.roomId,snapshot.url,msgs);
      if(added.length){
        s.monitorLastActivity=Date.now();
        b.log('Observed '+added.length+' live private-chat message(s).');
      }
    }
  }
  async clearJournal(roomId){
    this.ensureRoomManagementIdle();
    if(!NomiApiRoom.safeNomiId(roomId))throw Error('Choose a valid API room.');
    await this.observer.clear(roomId);return {cleared:true};
  }
  async journalState(roomId){
    if(!NomiApiRoom.safeNomiId(roomId))throw Error('Choose a valid API room.');
    const j=await this.observer.load(roomId);
    return {events:j.events.slice(-10),count:j.events.length,nextSeq:j.nextSeq};
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
    // Tab/document IDs can change after a browser restart; full original
    // message text and conversation URL must still match exactly.
    if(!source||source.url!==cp.sourceUrl||source.reply!==(cp.sourceFullReply||cp.text)||
      source.busy||source.complete===false)
      throw Error('Original ChatGPT message is unavailable or changed; cannot safely resume this room.');
    cp.sourceDocument=source.document;
    cp.sourceReplyKey=source.replyKey;
    await this.checkpoint.save(cp);
  }
  async sendChunks(cp,{mustRun=false}={}) {
    // Defense in depth, including explicit checkpoint recovery: NEVER send a
    // control tag as messageText, even if a caller bypasses the normal parser.
    const parsed=parseWorldCommand(cp.text);
    if(parsed.kind!=='room'||parsed.text!==cp.text)
      throw Error('Checkpoint text contains a bridge command, not a world message. No Nomi POST attempted.');
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
    await this.transaction(()=>{
      const b=this.getBridge(),s=b?.apiSession;
      if(s?.roomId===cp.roomId) {
        s.replyWaitStartedAt=Date.now();
        s.replyAttemptsInTurn=0;
        s.replyLastErrorType=null;
        s.replyLastHttpStatus=null;
        s.replyNextRetrySeconds=null;
      }
    });
    while(true) {
      if(this.waitCancelled||!this.getBridge()?.running) {
        await this.checkpoint.mark(cp,'reply_not_ready','reply_wait_paused');
        throw Error('Reply waiting paused. Resume the confirmed reply request from Recovery.');
      }
      tryNumber++;
      await this.checkpoint.replyAttempt(cp);
      await this.transaction(()=>{
        const b=this.getBridge();
        if(b.apiSession?.roomId===cp.roomId){
          b.apiSession.roomReplyRequests=(b.apiSession.roomReplyRequests||0)+1;
          b.apiSession.replyAttemptsInTurn=tryNumber;
          b.apiSession.replyNextRetrySeconds=null;
          b.log('Nomi API /chat/request attempt '+tryNumber+
            ' (session total '+b.apiSession.roomReplyRequests+').');
        }
      });
      try {
        const text=NomiApiRoom.nomiReplyText(await this.request('/rooms/'+cp.roomId+'/chat/request',
          'POST',{nomiUuid:cp.nomiUuid}));
        await this.checkpoint.replyCommitted(cp,text);
        await this.transaction(()=>{
          const b=this.getBridge(),s=b?.apiSession;
          if(s?.roomId===cp.roomId){
            if(tryNumber>1){
              const message='Nomi API room reply succeeded on attempt '+tryNumber+'.';
              if(!b.running||b.phase==='uncertain')b.note(message);
              else b.log(message);
            }
            s.replyLastErrorType=null;
            s.replyLastHttpStatus=null;
            s.replyNextRetrySeconds=null;
          }
        });
        return text;
      } catch(error) {
        if(this.notReady(error)) {
          await this.checkpoint.mark(cp,'reply_not_ready','reply_not_ready',
            {attempt:tryNumber,errorType:error.apiType,httpStatus:error.httpStatus});
          await this.transaction(()=>{
            const b=this.getBridge(),s=b?.apiSession;
            if(s?.roomId===cp.roomId){
              const type=String(error.apiType||'NotReady').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80);
              const code=Number.isInteger(error.httpStatus)?error.httpStatus:null;
              s.replyLastErrorType=type;
              s.replyLastHttpStatus=code;
              s.replyNextRetrySeconds=delay/1000;
              const waited=Math.floor((Date.now()-(s.replyWaitStartedAt||Date.now()))/1000);
              b.log('Nomi API '+type+(code===null?'':' (HTTP '+code+')')+
                ' after reply attempt '+tryNumber+'. Waiting '+(delay/1000)+
                's before next reply request; elapsed '+waited+
                's. Original world text was NOT resent.');
            }
          });
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
  async completeReply(cp,reply,startedFromRecovery=false,liveCursor=0,kind='room-reply') {
    await this.transaction(()=>{
      const b=this.getBridge(),s=b.apiSession;
      if(b.mode!=='api-room'||s?.roomId!==cp.roomId)return;
      if(!b.running||b.phase==='uncertain'||b.tabRetry){
        // The remote room reply was committed durably BEFORE this callback.
        // Do not erase the stop reason or attempt to send to a changed GPT
        // conversation. The operator can recover the already-saved reply.
        s.pendingReply='reply_saved';
        delete s.progress;
        b.note(b.tabRetry
          ?'Nomi API reply saved while waiting for the original ChatGPT tab to reconnect. '+
            'No room resend; it will be delivered when the original conversation returns.'
          :'Nomi API reply was saved after the bridge stopped. NOT delivered to GPT. '+
            'Restore the original ChatGPT conversation and use Recover Reply; '+
            'no additional Nomi API request or world POST is needed.');
        return;
      }
      const id=NomiApiRoom.apiRoomId(cp.roomId),prior=b.tabs[id]||{};
      s.pendingReply='delivering';delete s.progress;
      if(liveCursor)s.monitorPendingSeq=liveCursor;
      s.sequence=(s.sequence||0)+1;
      b.heartbeat(id,this.snapshot(cp.roomId,s.nomiName,prior,{
        busy:false,reply,replyKey:'api-'+cp.roomId+'-'+s.sequence
      }));
      if(startedFromRecovery) {
        b.phase='reply';b.command=null;b.source=id;
        b.baseline=prior.replyKey||'';b.startedWait=b.clock();
        b.running=true;
      }
      b.log(kind==='world-ack'?'World event delivered; acknowledging to GPT without requesting a Nomi room reply.':'Nomi replied in API room.');
    });
  }
  worldDeliveryAck(cp){
    return 'WORLD ENGINE DELIVERY CONFIRMED — internal bridge acknowledgement, NOT a Nomi message.\n'+
      'World event posted successfully to the API room ('+cp.total+' chunk'+
      (cp.total===1?'':'s')+'). No Nomi room response was requested.\n'+
      'Private conversation monitoring continues. This acknowledgement does not consume any live-chat history.\n'+
      'Choose [listening] to wait for and receive every complete User / Nomi exchange since the previous listen, '+
      'or issue a new [say room] world event when appropriate.';
  }
  async confirmWorldDelivery(cp,startedFromRecovery=false){
    if(cp.status!=='awaiting_reply')
      throw Error('Cannot acknowledge a world event before all API room chunks are confirmed.');
    const ack=this.worldDeliveryAck(cp);
    await this.checkpoint.replyCommitted(cp,ack);
    await this.completeReply(cp,ack,startedFromRecovery,0,'world-ack');
  }
  async publishObservation(roomId,text,liveCursor=0){
    const b=this.getBridge(),s=b.apiSession;
    if(b.mode!=='api-room'||s?.roomId!==roomId||!b.running)return;
    const id=NomiApiRoom.apiRoomId(roomId),prior=b.tabs[id]||{};
    await this.transaction(()=>{
      const state=this.getBridge(),session=state.apiSession;
      if(!state.running||session?.roomId!==roomId)return;
      session.pendingReply='observation_delivering';
      if(liveCursor)session.monitorPendingSeq=liveCursor;
      session.sequence=(session.sequence||0)+1;
      state.heartbeat(id,this.snapshot(roomId,session.nomiName,state.tabs[id]||{},{
        busy:false,reply:text,replyKey:'obs-'+roomId+'-'+session.sequence
      }));
      state.log('Forwarding live/world observations to GPT.');
    });
  }
  async deliverObservations(roomId,kind='tail',page=1){
    const s=this.getBridge().apiSession;
    const history=kind==='history'?await this.observer.historyPage(roomId,page):null;
    const entries=history?history.events:
      kind==='listening'?(await this.observer.tail(roomId,10)).filter(e=>e.channel==='live').slice(-2):
      await this.observer.tail(roomId,10);
    // Reading [tail]/[history] is a non-destructive lookback; only
    // delivery of a complete live exchange advances the live cursor.
    const intro=history?'WORLD ENGINE HISTORY page '+history.page+'/'+history.pages:
      kind==='listening'?'LATEST PRIVATE CHAT OBSERVATION':'LAST 10 WORLD/LIVE MESSAGES';
    let message=entries.length?this.observer.format(entries,intro,history?28000:85000):
      intro+' — No messages at this offset. If the private chat is closed, [say room] produces a Nomi room reply.\n';
    if(history && history.page<history.pages)
      message+='\n[Earlier retained events available: ask [history '+(history.page+1)+'] to continue.]';
    await this.publishObservation(roomId,message);
  }
  async handleWorldControl(cmd,s) {
    const parsed=parseWorldCommand(cmd.text);
    if(!['tail','history','listening','wait','chat','invalid'].includes(parsed.kind))return false;
    const b=this.getBridge(),id=b.pair?.[1];
    const info=await chrome.tabs.sendMessage(Number(cmd.source),{type:'inspect'});
    if(!await this.transaction(()=>this.getBridge().validateSource(cmd.id,info?.snapshot)))return true;
    if(parsed.kind==='invalid') {
      // Never send malformed controls to Nomi. Return actionable protocol
      // feedback to GPT via the virtual room, so GPT gets another turn to
      // correct itself rather than waiting forever on an unchanged reply.
      // Limit consecutive feedback loops to protect unattended operation.
      let feedback=false,failures=0;
      await this.transaction(()=>{
        const bridge=this.getBridge();
        if(!bridge.claim(id,cmd.id).allowed)return;
        bridge.acknowledge(id,{id:cmd.id});
        const session=bridge.apiSession;
        failures=session.protocolFailures=(session.protocolFailures||0)+1;
        session.pendingReply='protocol_feedback';
        bridge.log('World Engine protocol error: '+parsed.reason+
          ' Nothing was sent to Nomi. Attempt '+failures+'/3.');
        if(failures>=3){
          session.pendingReply='protocol_hold';
          bridge.stop('Three consecutive malformed World Engine commands. Nothing was sent to Nomi. Check GPT response formatting, then resume.');
        } else feedback=true;
      });
      if(feedback)await this.publishObservation(s.roomId,
        'WORLD ENGINE COMMAND REJECTED — INTERNAL BRIDGE FEEDBACK, NOT NOMI.\n'+
        parsed.reason+'\nNothing was sent to Nomi. This response is for GPT only.\n'+
        'Use ONE command on its own line: [listening], [tail], [history], or [say room] followed by world-event text.\n'+
        'You may explain your intent in prose BEFORE the standalone command; command names mentioned inside sentences are not executable.');
      return true;
    }
    if(s.protocolFailures)s.protocolFailures=0;
    // One-shot protocol: one [listening] command yields ONE catch-up
    // packet after a complete User->Nomi round trip, or a timeout/fallback
    // status. Never subscribe or emit later messages without another command.
    s.listenRequestPending=parsed.kind==='listening';
    if(parsed.kind==='chat') {
      await this.transaction(()=>{
        const bridge=this.getBridge();
        if(!bridge.claim(id,cmd.id).allowed)throw Error('World command is no longer current.');
        bridge.acknowledge(id,{id:cmd.id});
      });
      await this.publishObservation(s.roomId,'[say chat] is disabled. The World Engine writes to the API room only. Use [say room] to describe the world event.');
      return true;
    }
    await this.transaction(()=>{
      const bridge=this.getBridge();
      const claimed=bridge.claim(id,cmd.id);
      if(!claimed.allowed)throw Error('World command is no longer current.');
      bridge.acknowledge(id,{id:cmd.id});
      bridge.apiSession.pendingReply='observation_pending';
    });
    if(parsed.kind==='listening'||parsed.kind==='wait'){
      if(parsed.kind==='listening')
        b.log('One-shot [listening] accepted: waiting for a complete User / Nomi exchange since cursor #'+
          (s.monitorLastSeq||0)+'.');
      const recent=await this.observer.history(s.roomId);
      const exchange=s.monitorEnabled
        ? completedLiveExchange(recent,s.monitorLastSeq||0)
        : {events:[],cursor:s.monitorLastSeq||0};
      if(exchange.events.length){
        const report=this.observer.format(exchange.events,
          'EVERY COMPLETE USER / NOMI MESSAGE SINCE PREVIOUS LISTEN',28000)+
          (exchange.truncated?'\n[More completed messages are queued; send [listening] to retrieve the next batch.]':'');
        await this.publishObservation(s.roomId,report,exchange.cursor);
      }else {
        // [wait] remains an indefinite silent subscription. [listening] is
        // a bounded observation request: after 12 seconds without a complete
        // exchange, return control to GPT without moving the journal cursor.
        await this.transaction(()=>{
          const bridge=this.getBridge();
          if(bridge.apiSession?.roomId===s.roomId){
            bridge.apiSession.pendingReply='live_wait';
            bridge.apiSession.listenDeadline=parsed.kind==='listening'?Date.now()+12000:0;
          }
          bridge.log(parsed.kind==='listening'
            ? 'Checking for a complete User / Nomi exchange (up to 12 seconds). Unanswered messages remain buffered.'
            : 'Waiting silently for a complete User / Nomi exchange; no Nomi API request.');
        });
      }
    }else await this.deliverObservations(s.roomId,parsed.kind,parsed.page||1);
    return true;
  }
  async pump() {
    const b=this.getBridge();
    if(this.inFlight||!b?.running||b.mode!=='api-room')return;
    const s=b.apiSession,id=b.pair?.[1];
    if(!s||id!==NomiApiRoom.apiRoomId(s.roomId))return;
    // Keep the effective mode explicit, without disabling the monitor.
    // Later messages can automatically restore private-chat observation.
    const nextMode=this.isLiveAvailable(s)?'live':'room-only';
    if(s.monitorEffectiveMode!==nextMode){
      if(s.monitorEffectiveMode){
        b.log(nextMode==='live'
          ? 'Live private-chat monitoring restored; observing Test again.'
          : 'Private chat inactive/unavailable; continuing in API-room-only mode.');
      }
      s.monitorEffectiveMode=nextMode;
    }
    const cmd=b.command;
    // A Nomi reply already reached us while the GPT tab was missing.
    // Deliver that CHECKPOINTED reply only after the ORIGINAL GPT URL is
    // restored. Do not request Nomi to respond a second time.
    if(s.pendingReply==='reply_saved'&&b.running&&!b.tabRetry&&
       b.source===id&&b.phase==='reply'){
      this.inFlight=true;
      try {
        const cp=await this.checkpoint.load(s.roomId);
        if(cp?.status==='reply_received' && typeof cp.reply==='string')
          await this.completeReply(cp,cp.reply);
        else throw Error('Saved room reply checkpoint is unavailable.');
      }catch(error){await this.fail('Saved reply delivery halted: '+error.message);}
      finally{this.inFlight=false;queueMicrotask(()=>void this.pump());}
      return;
    }
    if(b.phase==='send'&&cmd?.target===id) {
      if(cmd.claimed)return;
      this.inFlight=true;this.waitCancelled=false;
      try {
        // Recognize controls even if the live monitor is disabled.
        // Otherwise [wait] would be posted literally to the Nomi room.
        if(await this.handleWorldControl(cmd,s))return;
        const parsed=parseWorldCommand(cmd.text);
        if(s.protocolFailures)s.protocolFailures=0;
        if(parsed.kind!=='room'||!parsed.text.trim())
          throw Error('Use [say room] followed by a world message, or [listening], [tail], [history], [wait].');
        s.listenRequestPending=false;
        const info=await chrome.tabs.sendMessage(Number(cmd.source),{type:'inspect'});
        const verified=await this.transaction(()=>this.getBridge().validateSource(cmd.id,info?.snapshot));
        if(!verified)return;
        const roomCommand={...cmd,text:parsed.text};
        if(this.isLiveAvailable(s)){
          const recorded=await this.observer.history(s.roomId);
          s.monitorWorldStartSeq=recorded.at(-1)?.seq||0;
        }
        const cp=await this.checkpoint.begin({roomId:s.roomId,nomiUuid:s.nomiUuid,
          command:roomCommand,chunks:NomiApiRoom.apiChunks(roomCommand.text)});
        const allowed=await this.transaction(()=>this.getBridge().claim(id,cmd.id).allowed);
        if(!allowed)throw Error('Source changed after checkpoint creation; inspect checkpoint.');
        await this.sendChunks(cp,{mustRun:true});
        await this.observer.roomEvent(s.roomId,'World Engine',roomCommand.text,'world-'+cp.turnId);
        await this.transaction(()=>{
          const b=this.getBridge();
          b.acknowledge(id,{id:cmd.id});
          b.apiSession.pendingReply='ready';
          b.heartbeat(id,this.snapshot(s.roomId,s.nomiName,b.tabs[id],{busy:true}));
          b.log('All '+cp.total+' chunks confirmed; '+(this.isLiveAvailable(s)?'monitoring live chat.':'Nomi API reply pending.'));
        });
      } catch(error) {await this.fail('API room send halted: '+error.message);}
      finally {this.inFlight=false;queueMicrotask(()=>void this.pump());}
      return;
    }
    if(b.source===id&&s.pendingReply==='live_wait'){
      // Listening after [wait] is passive. After a WORLD SEND the checkpoint
      // remains awaiting_reply so a Nomi room reply can be requested later
      // if the real conversation becomes inactive. Never replay old history
      // as if it were a new live message.
      const cp=await this.checkpoint.load(s.roomId);
      if(cp?.status==='awaiting_reply'&&this.isLiveAvailable(s)){
        // Upgrade an already-running 0.4.2 session that was stranded after
        // a confirmed world POST under the old wait-for-private-chat rule.
        // The world text was already posted: only ACK GPT, never resend it.
        this.inFlight=true;
        try {await this.confirmWorldDelivery(cp);}
        catch(error){await this.fail('World delivery acknowledgement halted: '+error.message);}
        finally {this.inFlight=false;queueMicrotask(()=>void this.pump());}
        return;
      }
      const exchange=s.monitorEnabled
        ? completedLiveExchange(await this.observer.history(s.roomId),s.monitorLastSeq||0)
        : {events:[],cursor:s.monitorLastSeq||0};
      // Eligibility looks across the whole completed backlog, not just the
      // first bounded delivery batch. Otherwise a busy chat can hold back
      // a new reply past the first packet and mistakenly trigger fallback.
      const allComplete=s.monitorEnabled
        ? completedLiveExchange(await this.observer.history(s.roomId),
            s.monitorLastSeq||0,Number.MAX_SAFE_INTEGER)
        : {events:[]};
      const eligible=cp?.status==='awaiting_reply'
        ? allComplete.events.some(e=>e.speaker==='Nomi'&&e.seq>(s.monitorWorldStartSeq||0))
        : !!exchange.events.length;
      if(eligible) {
        this.inFlight=true;
        try {
          const observation=this.observer.format(exchange.events,
            'EVERY COMPLETE USER / NOMI MESSAGE SINCE PREVIOUS LISTEN',28000)+
            (exchange.truncated?'\n[More completed messages are queued; send [listening] for the next batch.]':'');
          s.listenDeadline=0;
          if(cp?.status==='awaiting_reply'){
            await this.checkpoint.replyCommitted(cp,observation);
            await this.completeReply(cp,observation,false,exchange.cursor);
          } else {
            await this.publishObservation(s.roomId,observation,exchange.cursor);
          }
        } catch(error){await this.fail('Live observation delivery halted: '+error.message);}
        finally{this.inFlight=false;queueMicrotask(()=>void this.pump());}
      } else if((!cp||['completed','abandoned'].includes(cp.status))&&s.listenDeadline&&
          (!this.isLiveAvailable(s)||Date.now()>=s.listenDeadline)){
        // A bounded [listening] poll expired, or live monitoring has
        // fallen back to API-room-only operation. A COMPLETED world
        // checkpoint must not prevent the timeout from firing.
        // No Nomi API request, cursor advance, or transcript discard.
        this.inFlight=true;
        try {
          const recent=await this.observer.history(s.roomId);
          const unpaired=recent.filter(e=>e.channel==='live'&&e.seq>(s.monitorLastSeq||0));
          const roomOnly=!this.isLiveAvailable(s);
          await this.publishObservation(s.roomId,
            (roomOnly?'ROOM-ONLY FALLBACK ACTIVE':'LISTEN CHECK COMPLETE')+
            ' — INTERNAL BRIDGE STATUS, NOT NOMI.\n'+
            (roomOnly
              ? 'Private chat monitoring is disabled, disconnected or inactive. The World Engine remains running in API-room-only operation.\n'
              : 'No new complete User / Nomi round trip was observed in the last 12 seconds.\n')+
            (unpaired.length?'There are '+unpaired.length+' unacknowledged live message(s); the current incomplete exchange is still buffered.\n':'No newer private-chat messages have been observed.\n')+
            'No Nomi API request was made by this check, and no private-chat messages were discarded.\n'+
            (roomOnly
              ? 'Send [say room] with a world event to receive a Nomi API-room reply. Live monitoring resumes automatically when its tab and fresh conversation activity return.'
              : 'You may send [listening] again for the next completed exchange or [say room] to advance the world.'));
          s.listenDeadline=0;
        } catch(error){await this.fail('Listen check halted: '+error.message);}
        finally{this.inFlight=false;queueMicrotask(()=>void this.pump());}
      } else if(cp?.status==='awaiting_reply'&&!this.isLiveAvailable(s)){
        // No new private-chat activity. Fall back to ONE Nomi room reply for
        // the ALREADY SENT world event. Never resend the world content.
        this.inFlight=true;this.waitCancelled=false;
        try {
          await this.transaction(()=>{
            const state=this.getBridge();
            if(state.apiSession?.roomId===s.roomId){
              state.apiSession.pendingReply='inflight';
              state.log('Private chat inactive; requesting the pending Nomi API room reply.');
            }
          });
          const reply=await this.requestReply(cp);
          await this.observer.roomEvent(s.roomId,'Nomi',reply,'nomi-reply-'+cp.turnId);
          await this.completeReply(cp,reply);
        } catch(error){await this.fail('API room fallback halted: '+error.message);}
        finally{this.inFlight=false;queueMicrotask(()=>void this.pump());}
      }
      return;
    }
    if(b.source===id&&s.pendingReply==='ready') {
      this.inFlight=true;this.waitCancelled=false;
      try {
        const cp=await this.checkpoint.load(s.roomId);
        if(!cp||cp.status!=='awaiting_reply')throw Error('Missing confirmed content checkpoint; refusing reply request.');
        await this.transaction(()=>{this.getBridge().apiSession.pendingReply='inflight';});
        if(this.isLiveAvailable(s)){
          // The world event was successfully posted. Return a one-time
          // bridge delivery ACK to GPT NOW so GPT can choose [listening].
          // Do not wait for a private chat reply before releasing GPT.
          // Do not consume/advance the private-chat observation cursor.
          await this.confirmWorldDelivery(cp);
        }else {
          const reply=await this.requestReply(cp);
          await this.observer.roomEvent(s.roomId,'Nomi',reply,'nomi-reply-'+cp.turnId);
          await this.completeReply(cp,reply);
        }
      } catch(error) {await this.fail('API room reply halted: '+error.message);}
      finally {this.inFlight=false;queueMicrotask(()=>void this.pump());}
    }
  }
  stopWaiting() {this.waitCancelled=true;}
  startRecovery(roomId,kind,data={}) {
    if(this.inFlight||this.recoveryScheduled)throw Error('Recovery already in progress.');
    this.recoveryScheduled=true;
    void Promise.resolve().then(()=>this.recover(roomId,kind,data))
      .catch(error=>this.transaction(()=>this.getBridge().log('Recovery rejected: '+error.message)))
      .finally(()=>{this.recoveryScheduled=false;});
    return {started:true};
  }
  async recover(roomId,kind,data={}) {
    if(this.inFlight)throw Error('API operation in progress. Stop and retry after it finishes.');
    const cp=await this.checkpoint.load(roomId);
    if(!cp)throw Error('No checkpoint exists for this room.');
    if(this.getBridge()?.running)throw Error('Stop the bridge before recovering.');
    const b=this.getBridge(),selected=String(data.chatgptTab||b.pair?.[0]||'');
    if(!/^\d+$/.test(selected))throw Error('Choose the original ChatGPT conversation tab.');
    if(data.nomiUuid!==cp.nomiUuid)throw Error('Selected Nomi does not match the original checkpoint.');
    const src=await chrome.tabs.sendMessage(Number(selected),{type:'inspect'});
    if(!src?.snapshot||src.snapshot.site!=='chatgpt'||src.snapshot.url!==cp.sourceUrl||
       src.snapshot.busy||src.snapshot.complete===false)
       throw Error('The original ChatGPT conversation is not open and ready.');
    if(kind==='send'&&src.snapshot.reply!==(cp.sourceFullReply||cp.text))
       throw Error('Original World Engine response differs; content recovery is blocked.');
    cp.sourceTab=selected;
    cp.sourceDocument=src.snapshot.document;
    cp.sourceReplyKey=src.snapshot.replyKey;
    await this.checkpoint.save(cp);
    const id=NomiApiRoom.apiRoomId(roomId);
    await this.transaction(()=>{
      const b=this.getBridge();
      b.running=false;b.mode='api-room';b.phase='uncertain';b.command=null;
      b.pair=[selected,id];
      b.heartbeat(selected,src.snapshot);
      const old=b.tabs[id]||{};
      const name=b.apiSession?.roomId===roomId?b.apiSession.nomiName:'Nomi';
      const previous=b.apiSession?.roomId===roomId?b.apiSession:null;
      const monitorEnabled=!!data.monitorLive;
      b.apiSession={roomId,nomiUuid:cp.nomiUuid,nomiName:name,roomName:'Recovered API room',
        pendingReply:'uncertain',sequence:previous?.sequence||0,
        monitorEnabled,monitorTabId:monitorEnabled?String(data.monitorTab||''):'',
        monitorUrl:monitorEnabled?(previous?.monitorUrl||''):'',
        monitorSeen:0,monitorCount:0,monitorLastActivity:previous?.monitorLastActivity||0,
        monitorLastSeq:previous?.monitorLastSeq||0,
        monitorPendingSeq:previous?.monitorPendingSeq||0,
        listenRequestPending:previous?.listenRequestPending||false,
        monitorWorldStartSeq:previous?.monitorWorldStartSeq||0,
        listenDeadline:previous?.listenDeadline||0,
        monitorIdleSeconds:Math.max(60,Math.min(3600,Number(data.monitorIdleSeconds)||300))};
      b.heartbeat(id,this.snapshot(roomId,name,old));
    });
    if(kind==='send') {
      if(cp.status==='send_uncertain'&&cp.attemptedIndex!==cp.confirmed+1)
        throw Error('Uncertain chunk index mismatch.');
      if(!['send_uncertain','planned','sending','paused'].includes(cp.status))
        throw Error('There is no unfinished content send to recover.');
    } else if(kind==='reply') {
      if(!['reply_uncertain','reply_not_ready','awaiting_reply','reply_received'].includes(cp.status))
        throw Error('There is no unresolved reply request to recover.');
    } else throw Error('Unknown recovery type.');
    // Require the original exact source reply to still be present. No duplicate turn by accident.
    if(kind==='send')await this.verifiedSource(cp);
    this.inFlight=true;this.waitCancelled=false;
    try {
      if(kind==='send') {
        await this.checkpoint.recoverSend(cp,cp.confirmed+1);
        await this.sendChunks(cp,{mustRun:false});
      } else if(cp.status!=='reply_received') await this.checkpoint.recoverReply(cp);
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
      // If the world content is complete and no reply was requested yet,
      // recovering the live monitor is safe: don't manufacture a room reply
      // merely because Edge restarted. Resume with fresh live observations.
      const session=this.getBridge().apiSession;
      if(cp.status==='awaiting_reply'&&session?.monitorEnabled&&session.monitorTabId){
        try {
          const monitor=await chrome.tabs.sendMessage(Number(session.monitorTabId),{type:'inspect'});
          await this.observeLive(session.monitorTabId,monitor?.snapshot);
        } catch(error) {
          await this.transaction(()=>this.getBridge().log('Private-chat monitor not connected during recovery.'));
        }
      }
      if(cp.status==='awaiting_reply'&&this.isLiveAvailable(session)){
        await this.confirmWorldDelivery(cp,true);
        return {recovered:true,monitoring:true,worldAcknowledged:true,checkpoint:this.checkpoint.brief(cp)};
      }
      const reply=cp.status==='reply_received'?cp.reply:await this.requestReply(cp);
      await this.completeReply(cp,reply,true);
      return {recovered:true,checkpoint:this.checkpoint.brief(cp)};
    } catch(error) {
      await this.fail('Recovery halted: '+error.message);
      throw error;
    } finally {this.inFlight=false;queueMicrotask(()=>void this.pump());}
  }
  async forwarded(roomId) {
    const b=this.getBridge(),s=b.apiSession;
    // Cursor is acknowledged ONLY after ChatGPT's editor confirmed receipt.
    // A failed delivery must leave the complete exchange queued for retry.
    if(s?.roomId===roomId&&s.monitorPendingSeq){
      s.monitorLastSeq=Math.max(s.monitorLastSeq||0,s.monitorPendingSeq);
      s.monitorPendingSeq=0;
      b.log('Live catch-up confirmed through event #'+s.monitorLastSeq+'.');
    }
    if(s?.roomId===roomId&&['observation_delivering','observation_pending','protocol_feedback'].includes(s.pendingReply)){
      s.pendingReply='none';
      if(s.listenRequestPending){
        s.listenRequestPending=false;
        b.log('One-shot [listening] reply confirmed to GPT. Awaiting a NEW GPT command.');
      }
    }
    const cp=await this.checkpoint.load(roomId);
    if(cp?.status==='reply_received') {
      await this.checkpoint.delivered(cp);
      const b=this.getBridge();
      if(b.apiSession?.roomId===roomId)b.apiSession.pendingReply='none';
    }
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
