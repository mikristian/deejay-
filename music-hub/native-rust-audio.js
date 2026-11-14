/* Optional local Rust deck engine. No automatic activation or audio playback. */
(()=>{
  'use strict';
  const endpoint='http://127.0.0.1:18779';
  const ENGINE_PREFERENCE='music-hub-audio-engine-v1';
  const preferRust=()=>{
    try{return localStorage.getItem(ENGINE_PREFERENCE)==='rust';}catch{return false;}
  };
  const savePreference=mode=>{
    try{localStorage.setItem(ENGINE_PREFERENCE,mode);}catch{}
  };
  const validId=id=>/^\d{1,18}$/.test(String(id??''))&&String(id)!=='0';
  const validDeck=n=>Number(n)===1||Number(n)===2;
  const finite=n=>typeof n==='number'&&Number.isFinite(n);
  const bound=n=>Math.min(1,Math.max(0,n));
  const staged=[null,null];
  const loaded=[null,null];
  const inflight=[null,null];
  const playing=[false,false];
  let active=false,online=false,busy=false,lastError=null,serverStatus=null;
  let autoResumeAttempted=false;
  let healthPending=null;
  let original=null;
  let badge=null;
  const aliases={health:'/health',status:'/status',command:'/command'};
  async function request(route,payload){
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),1600);
    try{
      const response=await fetch(endpoint+aliases[route],{
        method:payload===undefined?'GET':'POST',
        headers:payload===undefined?undefined:{'Content-Type':'application/json'},
        body:payload===undefined?undefined:JSON.stringify(payload),
        mode:'cors',cache:'no-store',signal:controller.signal
      });
      if(!response.ok)throw Error(`Rust ${route}: HTTP ${response.status}`);
      const body=await response.text();
      return body?JSON.parse(body):{};
    }finally{clearTimeout(timeout);}
  }
  function status(){return {engine:active?'rust':'web',online,busy,loaded:[...loaded],staged:[...staged],playing:[...playing],lastError,server:serverStatus};}
  function paint(){
    if(!badge)return;
    badge.textContent=active?'AUDIO: RUST':online?'AUDIO: WEB':'AUDIO: WEB';
    badge.setAttribute('aria-pressed',String(active));
    badge.disabled=busy||(!online&&!active);
    badge.title=busy?'Audio engine switching…':active?'Switch back to Web Audio (paused)':'Use local Rust audio engine (requires both staged tracks loaded)';
    badge.dataset.engine=active?'rust':'web';
    badge.dataset.online=String(online);
  }
  function broadcast(){
    paint();
    window.dispatchEvent(new CustomEvent('music-hub:audio-engine',{detail:status()}));
  }
  function health(){
    if(healthPending)return healthPending;
    healthPending=checkHealth();
    return healthPending;
  }
  async function checkHealth(){
    try{
      const answer=await request('health');
      if(answer?.ok!==true||answer?.audioStreamStarted!==true)throw Error('Rust audio stream is not ready');
      online=true;lastError=null;
      serverStatus=await request('status');
      if(active&&Array.isArray(serverStatus?.decks)){
        for(let i=0;i<2;i++){
          const deck=serverStatus.decks.find(entry=>entry.deck===i+1);
          if(deck&&String(deck.trackId)===staged[i])playing[i]=deck.playing===true;
        }
        window.MusicHubTopDecks?.syncExternalTransport?.(serverStatus.decks);
      }
      return true;
    }catch(error){
      online=false;lastError=String(error.message||error);
      if(active)await deactivate('Rust connection lost');
      return false;
    }finally{healthPending=null;broadcast();}
  }
  function pauseWeb(){
    // Existing deck audio and footer preview are separate media elements.
    for(const audio of document.querySelectorAll('audio')){
      try{audio.pause();}catch{}
    }
  }
  let statusPolling=false;
  async function pollLiveStatus(){
    if(!active||statusPolling)return;
    statusPolling=true;
    try{
      serverStatus=await request('status');
      if(serverStatus?.ok!==true||!Array.isArray(serverStatus.decks))
        throw Error('Rust deck status unavailable');
      for(let i=0;i<2;i++){
        const deck=serverStatus.decks.find(entry=>entry.deck===i+1);
        if(deck&&String(deck.trackId)===staged[i])playing[i]=deck.playing===true;
      }
      window.MusicHubTopDecks?.syncExternalTransport?.(serverStatus.decks);
    }catch(error){fault(error);await deactivate('Rust status disconnected');}
    finally{statusPolling=false;}
  }
  async function silenceRust(){
    await Promise.allSettled([1,2].map(deck=>request('command',{deck,action:'pause'})));
    playing.fill(false);
  }
  async function deactivate(reason){
    if(!active)return true;
    active=false;
    await silenceRust();
    window.MusicHubTopDecks?.clearExternalTransport?.();
    if(!reason)savePreference('web');
    if(reason)lastError=reason;
    broadcast();
    return true;
  }
  function stage(deck,id){
    if(!validDeck(deck))return false;
    const index=Number(deck)-1;
    const next=validId(id)?String(id):null;
    if(staged[index]!==next){
      staged[index]=next;loaded[index]=null;playing[index]=false;
      if(active){
        void request('command',{deck:Number(deck),action:'pause'}).catch(fault);
      }
    }
    if(next&&online)void preload(deck);
    broadcast();return true;
  }
  async function preload(deck){
    if(!validDeck(deck))return false;
    const i=Number(deck)-1,id=staged[i];
    if(!online||!validId(id))return false;
    if(loaded[i]===id)return true;
    if(inflight[i]?.id===id)return inflight[i].promise;
    const promise=decodeAndStage(i,Number(deck),id);
    inflight[i]={id,promise};
    try{return await promise;}finally{if(inflight[i]?.promise===promise)inflight[i]=null;}
  }
  async function decodeAndStage(i,deck,id){
    try{
      const result=await request('command',{action:'load',deck,trackId:id});
      if(result?.ok===false)throw Error(result.error||'Rust track load rejected');
      let ready=false;
      // A 202 response acknowledges asynchronous decode, not playable audio.
      for(let attempt=0;attempt<120;attempt++){
        if(staged[i]!==id)return false;
        const state=await request('status');
        const actual=state.decks?.find(entry=>entry.deck===deck)?.trackId;
        if(String(actual)===id){ready=true;break;}
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      if(!ready)throw Error('Rust did not confirm decoded track '+id);
      if(staged[i]!==id)return false;
      loaded[i]=id;
      broadcast();return true;
    }catch(error){
      if(staged[i]===id){loaded[i]=null;fault(error);}
      return false;
    }
  }
  function fault(error){lastError=String(error?.message||error);broadcast();}
  async function activate(){
    if(active)return true;
    if(busy)return false;
    busy=true;broadcast();
    try{
      if(!await health())throw Error('Rust service is offline');
      const targets=staged.map((id,i)=>id?i+1:null).filter(Boolean);
      if(!targets.length)throw Error('Stage a local track before enabling Rust audio');
      if(!targets.every(n=>validId(staged[n-1])))throw Error('Invalid track IDs');
      const results=await Promise.all(targets.map(n=>loaded[n-1]===staged[n-1]?true:preload(n)));
      if(!results.every(Boolean))throw Error('Rust could not preload every staged track');
      // Silence all browser playback before any Rust transport is enabled.
      pauseWeb();
      await silenceRust();
      active=true;lastError=null;
      const state=original.mixerState?.()||{};
      const commands=[{action:'crossfade',value:state.crossfade},{action:'master',value:state.masterLevel}];
      for(let i=0;i<2;i++){
        if(finite(state.channelFaders?.[i]))commands.push({action:'channel_fader',deck:i+1,value:state.channelFaders[i]});
        if(finite(state.trim?.[i]))commands.push({action:'trim',deck:i+1,value:state.trim[i]});
        if(finite(state.filters?.[i]))commands.push({action:'filter',deck:i+1,value:state.filters[i]});
        if(finite(state.tempo?.[i]))commands.push({action:'tempo',deck:i+1,value:state.tempo[i]*2/3});
        for(const band of ['low','mid','high'])if(finite(state.eq?.[i]?.[band]))
          commands.push({action:'eq',deck:i+1,band,value:state.eq[i][band]});
      }
      await Promise.all(commands.filter(command=>finite(command.value)).map(command=>request('command',command)));
      savePreference('rust');
      return true;
    }catch(error){
      fault(error);
      if(active)await deactivate('Rust engine setup failed');
      return false;
    }
    finally{busy=false;broadcast();}
  }
  async function transport(deck,action,extras={}){
    if(!active||!validDeck(deck))return false;
    const i=Number(deck)-1;
    if(!staged[i]||loaded[i]!==staged[i])return false;
    try{
      await request('command',{deck:Number(deck),action,...extras});
      if(action==='play')playing[i]=true;
      if(action==='pause')playing[i]=false;
      broadcast();return true;
    }catch(error){fault(error);await deactivate('Rust transport error');return false;}
  }
  function submitTransport(deck,action,extras){
    if(!active||!validDeck(deck)||loaded[Number(deck)-1]!==staged[Number(deck)-1])return false;
    void transport(deck,action,extras);return true;
  }
  function mixer(payload){
    if(!active)return;
    void request('command',payload).catch(error=>{fault(error);void deactivate('Rust mixer connection lost');});
  }
  function install(){
    const api=window.MusicHubTopDecks;
    if(!api||api.__rustAdapterInstalled)return false;
    original={...api};
    api.__rustAdapterInstalled=true;
    const previousSetDeck=api.setDeck;
    api.setDeck=function(deck,options){
      const result=previousSetDeck.apply(this,arguments);
      stage(deck,options?.verified?null:options?.track?.id);
      return result;
    };
    const previousPreload=api.preloadDeck;
    api.preloadDeck=function(deck){
      if(active){void preload(deck);return validDeck(deck)&&validId(staged[Number(deck)-1]);}
      const result=previousPreload.apply(this,arguments);
      if(online)void preload(deck);
      return result;
    };
    for(const name of ['playDeck','startDeck']){
      const previous=api[name];
      api[name]=function(deck){
        if(!active)return previous.apply(this,arguments);
        const i=Number(deck)-1;
        return submitTransport(deck,name==='startDeck'?'play':playing[i]?'pause':'play');
      };
    }
    // These legacy handlers close over Web Audio preview transport. Until a
    // corresponding Rust command exists, decline them while Rust is active.
    for(const name of ['cueDeck','syncDeck','jogDeck','jogShiftDeck','touchJogDeck',
      'loopIn','loopOut','loopFourBeat','loopExit','loopHalf','loopDouble',
      'triggerHotCue','beatJump','beatLoop','fadeTo','autoTransition']){
      if(typeof api[name]!=='function')continue;
      const previous=api[name];
      api[name]=function(){return active?false:previous.apply(this,arguments);};
    }
    const oldSeek=api.seekDeck;
    api.seekDeck=function(index,ratio){
      if(!active)return oldSeek.apply(this,arguments);
      if(!Number.isInteger(index)||index<0||index>1||!finite(ratio))return false;
      const local=original.localStatus();
      const duration=index===0?local.durationA:local.durationB;
      if(!(duration>0))return false;
    return submitTransport(index+1,'seek',{value:bound(ratio)});
    };
    for(const name of ['setCrossfade','setChannelFader','setMasterLevel','setTrim','setEq','setFilter','setTempo']){
      const previous=api[name];if(typeof previous!=='function')continue;
      api[name]=function(...args){
        const ok=previous.apply(this,args);
        if(ok!==true||!active)return ok;
        if(name==='setCrossfade')mixer({action:'crossfade',value:args[0]});
        else if(name==='setMasterLevel')mixer({action:'master',value:args[0]});
        else if(name==='setChannelFader')mixer({action:'channel_fader',deck:Number(args[0]),value:args[1]});
        else if(name==='setTrim')mixer({action:'trim',deck:Number(args[0]),value:args[1]});
        else if(name==='setEq')mixer({action:'eq',deck:Number(args[0]),band:args[1],value:args[2]});
        else if(name==='setFilter')mixer({action:'filter',deck:Number(args[0]),value:args[1]});
        else if(name==='setTempo')mixer({action:'tempo',deck:Number(args[0]),value:args[1]*2/3});
        return ok;
      };
    }
    api.localStatus=function(){
      const snapshot=original.localStatus();
      if(!active)return snapshot;
      const sampleRate=Number(serverStatus?.sampleRate)||44100;
      const deck=(index)=>serverStatus?.decks?.find(entry=>entry.deck===index+1&&
        String(entry.trackId)===staged[index]);
      const a=deck(0),b=deck(1);
      return {...snapshot,source:'rust-local',playingA:playing[0],playingB:playing[1],
        positionA:a?Number(a.positionSeconds??a.positionFrames/sampleRate):null,
        positionB:b?Number(b.positionSeconds??b.positionFrames/sampleRate):null,
        durationA:a?Number(a.durationSeconds??a.lengthFrames/sampleRate):snapshot.durationA,
        durationB:b?Number(b.durationSeconds??b.lengthFrames/sampleRate):snapshot.durationB,
        rust:status()};
    };
    const before=original.localStatus?.()||{};
    stage(1,before.verifiedA?null:before.deckA);
    stage(2,before.verifiedB?null:before.deckB);
    // Existing on-screen deck scrub handlers close over the old Web Audio
    // functions. Intercept their input events before those handlers execute.
    document.addEventListener('click',event=>{
      if(!active)return;
      if(event.target.closest?.('#top-decks-auto-fade')){
        event.preventDefault();event.stopImmediatePropagation();return;
      }
      const target=event.target.closest?.('.top-decks-preview-play,.pc-transport-play');
      if(!target)return;
      const lane=target.closest('[data-deck], [data-pc-deck]');
      const numbered=target.id.match(/^top-decks-preview-play-([12])$/);
      const deck=Number(numbered?.[1]||lane?.getAttribute('data-deck')||lane?.getAttribute('data-pc-deck'));
      if(!validDeck(deck))return;
      event.preventDefault();event.stopImmediatePropagation();api.playDeck(deck);
    },true);
    document.addEventListener('input',event=>{
      if(!active)return;
      if(event.target?.id==='top-decks-crossfade'){
        event.stopImmediatePropagation();
        api.setCrossfade(Number(event.target.value)/100);
        return;
      }
      const seek=event.target?.id?.match(/^top-decks-seek-([12])$/);
      if(!seek)return;
      event.stopImmediatePropagation();
      api.seekDeck(Number(seek[1])-1,Number(event.target.value)/1000);
    },true);
    let scrubPointer=null;
    const scrubWave=(event,down)=>{
      if(!active)return;
      const match=event.target?.id?.match(/^deck-(one|two)-wave$/);
      if(!match||event.button!==undefined&&down&&event.button!==0)return;
      if(!down&&scrubPointer!==event.pointerId)return;
      const bounds=event.target.getBoundingClientRect();
      if(!(bounds.width>0))return;
      event.preventDefault();event.stopImmediatePropagation();
      if(down){scrubPointer=event.pointerId;event.target.setPointerCapture?.(event.pointerId);}
      api.seekDeck(match[1]==='one'?0:1,bound((event.clientX-bounds.left)/bounds.width));
    };
    document.addEventListener('pointerdown',event=>scrubWave(event,true),true);
    document.addEventListener('pointermove',event=>scrubWave(event,false),true);
    for(const type of ['pointerup','pointercancel'])document.addEventListener(type,()=>{scrubPointer=null;},true);
    document.addEventListener('play',event=>{
      if(active&&event.target?.tagName==='AUDIO')try{event.target.pause();}catch{}
    },true);
    return true;
  }
  function makeButton(){
    // Top toolbar remains visible when waveform and performance panels collapse.
    const toolbar=document.querySelector('.toolbar-actions');
    if(!toolbar||badge)return;
    badge=document.createElement('button');
    badge.type='button';badge.id='native-rust-audio-toggle';badge.className='toolbar-chip';
    badge.setAttribute('aria-label','Select audio playback engine');
    badge.addEventListener('click',()=>{if(active)void deactivate();else void activate();});
    toolbar.appendChild(badge);paint();
  }
  function init(){
    install();
    // The Swift WKWebView does not necessarily register a script handler.
    // Limit cross-origin Rust access to the local desktop Music Hub origin.
    if(window.location?.hostname!=='127.0.0.1'||window.location?.port!=='18769')return;
    makeButton();
    const maybeResume=()=>{
      if(autoResumeAttempted||busy||active||!online||!preferRust()||
          !staged.some(validId))return;
      autoResumeAttempted=true;
      void activate();
    };
    void health().then(maybeResume);
    setInterval(()=>{void health().then(maybeResume);},4000);
    setInterval(()=>{void pollLiveStatus();},350);
  }
  window.MusicHubRustAudio={status,health,activate,deactivate,preload,transport,install};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});
  else init();
})();
