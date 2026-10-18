/* Single-tab repeating user prompt. Uses the same once-only send handshake. */
const HeartbeatBase = typeof module !== 'undefined' ? require('./group.js').GroupBridge : globalThis.GroupBridge;
class HeartbeatBridge extends HeartbeatBase {
  start(data) {
    if(data.mode !== 'heartbeat') {
      if(this.mode === 'heartbeat') {if(this.running)throw Error('Stop first.');this.reset();this.mode='direct';}
      return super.start(data);
    }
    if(this.running)throw Error('Already running.');
    if(this.phase==='uncertain')throw Error('Check the chat, then Reset after an uncertain send.');
    const id=String(data.tabs?.[0]||''), tab=this.tabs[id];
    const phrase=String(data.heartbeatText||'').trim(), delay=Number(data.heartbeatDelay ?? 10);
    if(!phrase)throw Error('Enter a heartbeat phrase.');
    if(!Number.isFinite(delay)||delay<1||delay>86400)throw Error('Heartbeat delay must be 1–86400 seconds.');
    if(!tab||tab.site!=='chatgpt'||!tab.ready||tab.draft||tab.error||this.clock()-tab.seen>90)throw Error('Choose a connected ChatGPT tab with an empty editor.');
    const same=this.mode==='heartbeat'&&this.pair?.[0]===id&&this.pulse?.text===phrase&&this.pulse.delay===delay&&this.phase!=='idle';
    if(!same){this.command=null;this.turns=0;this.phase='pulse-ready';this.pulse={text:phrase,delay,baseline:null,due:this.clock()};}
    this.mode='heartbeat';this.pair=[id];this.source=id;this.stableSeconds=Math.max(3,Math.min(60,Number(data.settle)||8));
    if(this.command&&!this.command.claimed)this.command.created=this.clock();
    this.running=true;this.log('Heartbeat running. Waiting for ChatGPT to be ready.');this.tick();
  }
  reset(){super.reset();this.pulse=null;}
  tick(){
    if(this.mode!=='heartbeat')return super.tick();
    if(!this.running)return;
    const now=this.clock(),id=this.pair[0],tab=this.tabs[id],p=this.pulse;
    if(!tab||now-tab.seen>120){this.reason='Waiting for the selected ChatGPT tab to reconnect.';return;}
    if(this.phase==='send'){
      if(now-this.command.created>90){this.phase='uncertain';this.stop('Heartbeat delivery not confirmed. Check the chat, then Reset.');}return;
    }
    if(tab.draft){this.reason='Heartbeat waiting: the editor contains a draft.';return;}
    if(tab.busy||!tab.ready||(tab.reply&&tab.complete===false)){this.reason='Waiting for ChatGPT to finish.';return;}
    if(this.phase==='pulse-reply'){
      if(!tab.reply||tab.replyKey===p.baseline||tab.complete!==true||now-tab.changed<this.stableSeconds){this.reason='Waiting for the completed heartbeat response.';return;}
      const sleep=tab.reply.trim().match(/^\[sleep(?:\s+(\d+(?:\.\d+)?)\s*HRS)?\]$/i);
      if(sleep){
        p.completedKey=tab.replyKey;
        if(!sleep[1]){this.phase='pulse-ready';p.due=now;this.stop('GPT requested [sleep]. Heartbeat is off until you press Play.');return;}
        const hours=Number(sleep[1]);
        if(Number.isFinite(hours)&&hours>0&&Number.isFinite(now+hours*3600)){
          p.due=now+hours*3600;this.phase='pulse-sleep';
          this.log(`GPT requested sleep for ${hours} hours. Stop cancels automatic resumption.`);
        }
      }
      if(this.phase==='pulse-reply'){
      p.due=now+p.delay;p.completedKey=tab.replyKey;this.phase='pulse-delay';
      }
    }
    if(this.phase==='pulse-delay'&&p.completedKey!==tab.replyKey){p.completedKey=tab.replyKey;p.due=now+p.delay;}
    if(now<p.due){this.reason=`${this.phase==='pulse-sleep'?'Sleeping; next':'Next'} heartbeat in ${Math.ceil(p.due-now)} seconds.`;return;}
    if(tab.reply&&now-tab.changed<this.stableSeconds)return;
    const text=p.text+(p.instructed?'':'\n\n[Heartbeat controls: This user-authorized heartbeat repeats after your completed response and a configurable delay. To switch it off, reply with exactly [sleep]. To suspend it for n hours, reply with exactly [sleep nHRS], replacing n with a positive number (for example [sleep 2HRS] or [sleep 0.5HRS]). Otherwise continue the user’s task.]');
    this.command={id:crypto.randomUUID(),target:id,source:id,text,url:tab.url,document:tab.document,sourceReply:tab.reply,sourceKey:tab.replyKey,sourceUrl:tab.url,sourceDocument:tab.document,baseline:tab.replyKey,claimed:false,created:now,heartbeatPrompt:true};
    this.phase='send';this.log('Sending heartbeat to ChatGPT.');
  }
  validateSource(id,snapshot){
    if(this.mode!=='heartbeat')return super.validateSource(id,snapshot);
    const c=this.command;
    if(!this.running||this.phase!=='send'||c?.id!==id)return false;
    const valid=snapshot&&!snapshot.error&&!snapshot.busy&&snapshot.url===c.url&&snapshot.document===c.document&&snapshot.reply===c.sourceReply&&snapshot.replyKey===c.sourceKey&&(!snapshot.reply||snapshot.complete!==false);
    if(!valid){this.phase=c.claimed?'uncertain':'pulse-ready';this.command=null;this.stop('ChatGPT changed before heartbeat submission. Check the chat before resuming.');}
    return !!valid;
  }
  acknowledge(tab,data){
    if(this.mode!=='heartbeat')return super.acknowledge(tab,data);
    const c=this.command;
    if(this.phase!=='send'||c?.id!==data.id||c.target!==tab||!c.claimed)return {};
    if(data.error){this.phase='uncertain';this.stop('Heartbeat send not confirmed: '+data.error);}
    else{
      this.lastDelivery={from:'heartbeat',to:'chatgpt',sentCharacters:c.text.length,truncated:false};
      this.pulse.instructed=true;this.pulse.baseline=c.baseline;this.phase='pulse-reply';this.turns++;this.log('Heartbeat sent. Waiting for ChatGPT’s response.');
    }
    this.command=null;return {};
  }
  state(){return {...super.state(),heartbeatSettings:this.mode==='heartbeat'?{text:this.pulse?.text,delay:this.pulse?.delay}:null};}
}
if(typeof module!=='undefined')module.exports={HeartbeatBridge};
else globalThis.HeartbeatBridge=HeartbeatBridge;
