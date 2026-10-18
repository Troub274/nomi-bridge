/* Persistent per-room checkpoint journal for Nomi API sends and replies.
 * Separate from session snapshots. No API key is persisted here.
 * The pending GPT turn text is retained locally ONLY until the turn commits.
 */
class ApiRoomCheckpoint {
  constructor(storage = chrome.storage.local) {
    this.storage = storage;
  }
  key(roomId) {return 'nomiApiCheckpoint:' + roomId;}
  async load(roomId) {
    return (await this.storage.get(this.key(roomId)))[this.key(roomId)] || null;
  }
  async save(cp) {
    cp.updatedAt = new Date().toISOString();
    await this.storage.set({[this.key(cp.roomId)]:cp});
    return cp;
  }
  async begin({roomId,nomiUuid,command,chunks}) {
    const previous=await this.load(roomId);
    if (previous && previous.status!=='completed' && previous.status!=='abandoned')
      throw Error('Unfinished API room checkpoint exists. Recover it before a new send.');
    if (!command?.text || !chunks?.length) throw Error('Cannot checkpoint an empty send.');
    const cp = {
      version:1,turnId:command.id,roomId,nomiUuid,
      sourceTab:command.source,sourceUrl:command.sourceUrl,
      sourceDocument:command.sourceDocument,sourceReplyKey:command.sourceKey,
      sourceFullReply:command.sourceReply||command.text,
      text:command.text,
      total:chunks.length,confirmed:0,attemptedIndex:null,
      status:'planned', events:[],startedAt:new Date().toISOString()
    };
    this.event(cp,'start',{total:chunks.length});
    return this.save(cp);
  }
  event(cp,type,extra={}) {
    cp.events.push({type,at:new Date().toISOString(),...extra});
  }
  async mark(cp,status,event,extra={}) {
    cp.status=status;
    if (event) this.event(cp,event,extra);
    return this.save(cp);
  }
  async attempt(cp,index) {
    if (cp.confirmed!==index-1 || cp.attemptedIndex!==null)
      throw Error('Checkpoint position mismatch; inspect room before continuing.');
    cp.attemptedIndex=index;
    return this.mark(cp,'sending','attempt',{index});
  }
  async confirm(cp,index) {
    if (cp.attemptedIndex!==index || cp.confirmed!==index-1)
      throw Error('Mismatched send acknowledgement; stopping to avoid duplicate posts.');
    cp.confirmed=index;
    cp.attemptedIndex=null;
    return this.mark(cp,'sending','confirmed',{index});
  }
  async replyAttempt(cp) {
    if (cp.confirmed!==cp.total || cp.attemptedIndex!==null)
      throw Error('Cannot request reply before all content messages are confirmed.');
    return this.mark(cp,'reply_inflight','reply_attempt');
  }
  async replyCommitted(cp,reply) {
    // Commit the response before forwarding it to ChatGPT; a worker restart
    // must not lose an accepted reply and trigger a duplicate reply request.
    cp.reply=reply;
    cp.attemptedIndex=null;
    return this.mark(cp,'reply_received','reply_committed');
  }
  async delivered(cp) {
    if(cp.status!=='reply_received') throw Error('No committed reply is awaiting delivery.');
    cp.text=null;cp.reply=null;cp.sourceFullReply=null;
    return this.mark(cp,'completed','reply_forwarded');
  }
  async recoverSend(cp,index) {
    if (!['send_uncertain','paused','planned','sending'].includes(cp.status))
      throw Error('No recoverable content send at this checkpoint.');
    if (index !== cp.confirmed+1 || index>cp.total)
      throw Error('Recovery index does not match first unconfirmed chunk.');
    if (cp.attemptedIndex !== null && cp.attemptedIndex !== index)
      throw Error('Recovery index does not match the uncertain attempt.');
    if (cp.attemptedIndex===index) {
      this.event(cp,'send_retry_authorized',{index,duplicatePossible:true});
      cp.attemptedIndex=null;
    } else this.event(cp,'send_resume_authorized',{index});
    return this.mark(cp,'planned');
  }
  async recoverReply(cp) {
    if (!['reply_uncertain','reply_not_ready','awaiting_reply','reply_received'].includes(cp.status))
      throw Error('No unresolved reply request to recover.');
    this.event(cp,'reply_operator_override',{duplicateReplyPossible:cp.status==='reply_uncertain'});
    return this.mark(cp,'awaiting_reply');
  }
  async abandon(cp) {
    if (cp.status==='completed') throw Error('Completed checkpoint cannot be abandoned.');
    cp.text=null;cp.sourceFullReply=null;cp.reply=null;
    return this.mark(cp,'abandoned','operator_abandoned');
  }
  brief(cp) {
    return cp ? {roomId:cp.roomId,status:cp.status,confirmed:cp.confirmed,total:cp.total,
      attemptedIndex:cp.attemptedIndex,turnId:cp.turnId,updatedAt:cp.updatedAt,
      events:cp.events.slice(-15).map(e=>({...e}))} : null;
  }
}
globalThis.ApiRoomCheckpoint = ApiRoomCheckpoint;
if (typeof module !== 'undefined') module.exports = {ApiRoomCheckpoint};
