/* Passive physical FLX4 -> Music Hub LOCAL audio. Never sends controller MIDI.
 * The user explicitly enabled controller support for their installed Music Hub.
 * Uses the existing read-only FLX4 observer on the localhost runtime.
 */
(()=>{
  'use strict';
  const $=id=>document.getElementById(id);
  const SOURCE='physical_flx4';
  const wsUrl='ws://127.0.0.1:18765';
  let enabled=true,ready=false,socket=null,retry=null,lastPress=new Map(),midiConnected=false;
  const diagnostics={loadedAt:new Date().toISOString(),messages:0,hardwareMessages:0,
    handled:0,lastEvent:null,lastResult:null,lastError:null,selfTest:null,audioOutcome:null,
    midiLatencyMs:null,midiP95Ms:null,
    physicalCrossfader:{samples:0,left:false,center:false,right:false,
      complete:false,lastValue:null,lastGains:null,lastPhysicalAt:null}};
  const midiLatencies=[];
  let playbackVerification=0;
  const padModes={1:'hotcue',2:'hotcue'};
  // Vintage Sampler Lab runs in its own macOS window and audio process.
  // Observe its mode without importing a pad UI or playing its sounds here.
  let standaloneSampler={mode:null,engine:null};
  async function refreshStandaloneSampler(){
    if(typeof fetch!=='function')return;
    try{
      const response=await fetch('/api/music-hub/sampler/status',{cache:'no-store'});
      if(!response.ok)return;
      const state=await response.json();
      if(['deck','sampler'].includes(state?.mode)&&
          ['direct','vsl','browser','ableton'].includes(state?.engine))
        standaloneSampler={mode:state.mode,engine:state.engine};
    }catch{} // Sampler unavailable must not impact Rust decks or MIDI.
  }
  const headphone={1:false,2:false};
  const shiftHeld={1:false,2:false};
  const validDeck=n=>n===1||n===2;
  const fraction=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1;
  function invoke(target,name,...args){
    if(typeof target?.[name]!=='function')return false;
    return target[name](...args)===true;
  }
  function record(event,result,reason){
    const hardwareAt=Number(event?.hardware_at);
    if(Number.isFinite(hardwareAt)&&hardwareAt>0){
      const measured=Date.now()-hardwareAt*1000;
      if(measured>=0&&measured<10000){
        const rounded=Math.round(measured*10)/10;
        diagnostics.midiLatencyMs=rounded;
        midiLatencies.push(rounded);
        if(midiLatencies.length>120)midiLatencies.shift();
        const sorted=[...midiLatencies].sort((a,b)=>a-b);
        diagnostics.midiP95Ms=sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))];
      }
    }
    diagnostics.lastEvent={action:event?.action||null,control:event?.control||null,
      deck:event?.deck||null,pressed:event?.pressed??null,
      value:typeof event?.value==='number'&&Number.isFinite(event.value)?
        Math.round(event.value*10000)/10000:null,
      diagnosticTest:event?.diagnosticTest===true,
      receivedAt:new Date().toISOString()};
    diagnostics.lastResult={ok:result===true,reason:String(reason||'').slice(0,180),
      at:new Date().toISOString()};
    if(result===true)diagnostics.handled++;
  }
  function observePhysicalCrossfader(event,mixer){
    // Synthetic menu tests are never evidence of a moved physical control.
    if(!Number.isFinite(Number(event?.hardware_at))||Number(event.hardware_at)<=0||
        event.diagnosticTest===true)return;
    const sweep=diagnostics.physicalCrossfader;
    const value=Number(event.value);
    sweep.samples++;
    sweep.left=sweep.left||value<=.06;
    sweep.center=sweep.center||(value>=.46&&value<=.54);
    sweep.right=sweep.right||value>=.94;
    sweep.complete=sweep.left&&sweep.center&&sweep.right;
    sweep.lastValue=Math.round(value*1000)/1000;
    const gains=mixer?.mixerState?.()?.masterGain;
    sweep.lastGains=Array.isArray(gains)&&gains.length===2?gains.map(x=>
      Number.isFinite(Number(x))?Math.round(Number(x)*10000)/10000:null):null;
    sweep.lastPhysicalAt=new Date().toISOString();
    const status=$('physical-flx4-sweep');
    if(status)status.textContent=sweep.complete?
      'PHYSICAL CROSSFADE SWEEP RECEIVED · LEFT + CENTER + RIGHT':
      'Physical fader test: '+(sweep.left?'LEFT ✓':'LEFT ○')+'  '+
      (sweep.center?'CENTER ✓':'CENTER ○')+'  '+(sweep.right?'RIGHT ✓':'RIGHT ○');
  }
  const controller=()=>window.MusicHubDesktopController;
  const deck=()=>window.MusicHubTopDecks;
  const allowed=()=>!(controller()?.verified?.().a||controller()?.verified?.().b);
  function output(message){
    const label=$('physical-flx4-status');
    if(label)label.textContent=message;
    const toggle=$('physical-flx4-toggle');
    if(toggle){
      toggle.textContent=enabled?'FLX4 · ON':'FLX4 · OFF';
      toggle.setAttribute('aria-pressed',String(enabled));
      toggle.setAttribute('aria-label','Physical FLX4 Hub '+(enabled?'on':'off')+'. Click to '+(enabled?'disable':'enable'));
      toggle.title=message+' · Click to '+(enabled?'disable':'enable')+' FLX4 Hub';
    }
    const dot=$('physical-flx4-dot');
    if(dot){dot.dataset.state=!enabled?'off':ready&&midiConnected?'connected':'waiting';}
  }
  function processPhysical(event){
    if(!enabled||!ready||!event||event.source!==SOURCE){
      record(event,false,'controller disabled, WebSocket not ready or nonphysical source');
      return false;
    }
    if(!allowed()){
      record(event,false,'verified Rekordbox deck blocks duplicate audio');
      return false;
    }
    const command=controller(),mixer=deck();
    if(!command||!mixer){record(event,false,'desktop player not initialized');return false;}
    const unit=Number(event.deck);
    const continuous={hardware_crossfader:'setCrossfade',hardware_channel_fader:'setChannelFader',
      hardware_eq:'setEq',hardware_cfx:'setFilter',hardware_tempo:'setTempo',hardware_fx_level:'setFXLevel',
      hardware_master_level:'setMasterLevel',hardware_trim:'setTrim',
      hardware_headphone_mix:'setHeadphoneMix',hardware_headphone_level:'setHeadphoneLevel',
      hardware_mic_level:'setMicLevel'};
    if(Object.prototype.hasOwnProperty.call(continuous,event.action)){
      const globalControl=['hardware_crossfader','hardware_master_level','hardware_headphone_mix',
        'hardware_headphone_level','hardware_mic_level'].includes(event.action);
      if(!fraction(event.value)||!globalControl&&!validDeck(unit)&&!validDeck(Number(event.unit))){
        record(event,false,'invalid hardware fader value or deck');return false;
      }
      const target=event.action==='hardware_fx_level'?Number(event.unit):unit;
      const name=continuous[event.action];
      const args=globalControl?[event.value]:
        event.action==='hardware_eq'?[unit,event.band,event.value]:[target,event.value];
      if(event.action==='hardware_eq'&&!['high','mid','low'].includes(event.band))return false;
      const ok=invoke(mixer,name,...args);
      record(event,ok,ok?name+' applied':'deck API '+name+' unavailable or refused');
      if(ok&&event.action==='hardware_crossfader'){
        observePhysicalCrossfader(event,mixer);
        output('FLX4 crossfader · '+Math.round(event.value*100)+'%');
      }
      return ok;
    }
    if(event.action==='hardware_jog_rotate'){
      if(!validDeck(unit)||!Number.isInteger(event.delta)||!event.delta||Math.abs(event.delta)>63||
          !['scratch','pitch','shift'].includes(event.mode))return false;
      // Shifted jog is a separate transport gesture. Never downgrade it to a
      // normal jog seek when the deck engine has no dedicated implementation.
      const ok=event.mode==='shift'?invoke(mixer,'jogShiftDeck',unit,event.delta):
        invoke(mixer,'jogDeck',unit,event.delta,event.mode);
      record(event,ok,ok?'jog applied':'jog API unavailable or refused');return ok;
    }
    if(event.action==='hardware_jog_touch'){
      if(!validDeck(unit)||typeof event.touched!=='boolean')return false;
      const ok=invoke(mixer,'touchJogDeck',unit,event.touched,event.shifted===true);
      record(event,ok,ok?'jog touch applied':'jog touch API unavailable');return ok;
    }
    if(event.action==='hardware_pad_mode'){
      if(!validDeck(unit)||event.pressed!==true||
        !['hotcue','beatjump','sampler','padfx1','padfx2','beatloop'].includes(event.mode))return false;
      padModes[unit]=event.mode;
      const indicator=$('physical-flx4-pad-mode');
      if(indicator)indicator.textContent='Deck '+unit+' · '+event.mode.toUpperCase();
      record(event,true,'pad mode '+event.mode);return true;
    }
    if(event.action==='hardware_pad'){
      if(!validDeck(unit)||!Number.isInteger(event.pad)||event.pad<0||event.pad>7||event.pressed!==true)return false;
      const mode=event.mode||padModes[unit];
      let ok=false;
      const sampler=window.MusicHubSampler;
      const samplerState=sampler?.status?.()||standaloneSampler;
      if(['sampler','padfx1','padfx2'].includes(mode)&&samplerState?.mode==='sampler'){
        const engine=samplerState.engine;
        // Browser mode has no producer for the polled /sampler/events queue;
        // route the received physical press once through its browser player.
        // VSL and direct already receive physical presses natively, so a JS
        // trigger in those modes would duplicate the sample.
        if(engine==='browser'){
          if(typeof sampler.trigger!=='function'){
            record(event,false,'browser sampler is now separate; use Vintage Sampler Lab direct output');return false;
          }
          const pad=event.pad+1+(unit===2?8:0);
          try{
            Promise.resolve(sampler.trigger(pad)).catch(error=>{
              diagnostics.lastError=String(error);
            });
            record(event,true,'browser sampler pad '+pad+' triggered');return true;
          }catch(error){
            diagnostics.lastError=String(error);
            record(event,false,'browser sampler trigger failed');return false;
          }
        }
        const nativeOwned=engine==='vsl'||engine==='direct'||engine==='ableton';
        record(event,nativeOwned,nativeOwned?'sampler '+engine+' handles hardware natively':
          'unknown sampler engine');
        return nativeOwned;
      }else if(mode==='hotcue')ok=invoke(mixer,'triggerHotCue',unit,event.pad,event.shifted===true);
      else if(mode==='beatjump')ok=invoke(mixer,'beatJump',unit,event.pad,event.shifted===true);
      else if(mode==='beatloop')ok=invoke(mixer,'beatLoop',unit,event.pad,event.shifted===true);
      else if(mode==='padfx1'||mode==='padfx2')ok=invoke(mixer,'triggerPadFX',unit,event.pad,mode);
      record(event,ok,ok?'pad '+mode+' routed':'pad action unsupported or sampler off');return ok;
    }
    if(event.action==='hardware_browser_rotate'){
      const value=event.delta;
      if(!Number.isInteger(value)||value===0||Math.abs(value)>63)return false;
      const ok=command.browse?.(Math.max(-5,Math.min(5,value)))===true;
      if(ok)output('Browsing: '+(command.track?.(command.selectedId?.())?.title||'selected song'));
      record(event,ok,ok?'selected library track':'browse rejected');
      return ok;
    }
    if(event.action==='hardware_button'&&event.control==='shift'){
      if(!validDeck(unit)||typeof event.pressed!=='boolean')return false;
      shiftHeld[unit]=event.pressed;
      record(event,true,event.pressed?'shift held':'shift released');return true;
    }
    if(event.action!=='hardware_button'||event.pressed!==true)return false;
    const control=event.control;
    const other={cue:'cueDeck',sync:'syncDeck',shift_play:'shiftPlayDeck',shift_cue:'shiftCueDeck',
      headphone_master:'toggleMasterHeadphone',master_headphone:'toggleMasterHeadphone',
      loop_in:'loopIn',loop_out:'loopOut',loop_4beat:'loopFourBeat',loop_exit:'loopExit',
      loop_half:'loopHalf',loop_double:'loopDouble',
      fx_toggle:'toggleFX',
      fx_beat_down:'fxBeatDown',fx_beat_up:'fxBeatUp',
      fx_select_next:'fxSelectNext',fx_select_prev:'fxSelectPrev',
      smart_cfx:'toggleSmartCFX',smart_cfx_select:'selectSmartCFX',smart_fader:'toggleSmartFader'};
    if(control==='headphone'&&validDeck(unit)){
      const next=!headphone[unit],ok=invoke(mixer,'setHeadphoneCue',unit,next);
      if(ok)headphone[unit]=next;
      record(event,ok,ok?'headphone cue updated':'headphone cue unavailable');return ok;
    }
    if(control==='browser_back'){
      const ok=invoke(command,'browseBack');record(event,ok,ok?'browser back':'browser back unavailable');return ok;
    }
    if(Object.prototype.hasOwnProperty.call(other,control)){
      const target=control.startsWith('fx_')?Number(event.unit):unit;
      if((control.startsWith('fx_')||['cue','sync','shift_play','shift_cue','loop_in','loop_out','loop_4beat','loop_exit','loop_half','loop_double'].includes(control))&&!validDeck(target))return false;
      const ok=invoke(mixer,other[control],...(validDeck(target)?[target]:[]));
      record(event,ok,ok?control+' applied':control+' unavailable');return ok;
    }
    if(!['browser_press','load','play'].includes(control))return false;
    const loadUnit=control==='browser_press'?1:unit;
    if(!validDeck(loadUnit))return false;
    // Suppress double-processed MIDI packets without blocking deliberate taps.
    const key=control+':'+loadUnit,now=Date.now();
    if(now-(lastPress.get(key)||0)<170)return false;
    lastPress.set(key,now);
    if(control==='browser_press'||control==='load'){
      const id=command.selectedId?.()||command.firstPlayableId?.();
      if(!id){record(event,false,'no selectable music in library');output('Music library not ready; reconnecting…');return false;}
      if(command.selectedId?.()!==id)command.select?.(id);
      const ok=command.stage?.(loadUnit,id)===true;
      output(ok?(command.track?.(id)?.title||'Song')+' loaded on Deck '+(loadUnit===1?'A':'B'):
        'Cannot load: this Rekordbox deck is active');
      record(event,ok,ok?'local stage completed':'stage refused by Music Hub');
      return ok;
    }
    if(control==='play'){
      const current=mixer.localStatus?.();
      let id=unit===1?current?.deckA:current?.deckB;
      // PLAY works even if the user selected a song with the browse wheel
      // but hasn't pressed LOAD yet. Do not stage over a running local deck.
      if(!id){
        const chosen=command.selectedId?.()||command.firstPlayableId?.();
        if(chosen&&command.selectedId?.()!==chosen)command.select?.(chosen);
        if(!chosen||command.stage?.(unit,chosen)!==true){
          record(event,false,'no playable song was selected or available');
          output('Choose a song with the browse knob, then press PLAY');
          return false;
        }
        id=unit===1?mixer.localStatus?.()?.deckA:mixer.localStatus?.()?.deckB;
        if(!id){output('Selected song could not be loaded');return false;}
      }
      const ok=mixer.playDeck?.(unit)===true;
      output(ok?'Deck '+(unit===1?'A':'B')+' PLAY pressed · audio requested':'Local audio could not start');
      record(event,ok,ok?'HTML audio playback request issued':'playDeck returned false');
      if(ok){
        const generation=++playbackVerification;
        const before=Number(current?.[unit===1?'positionA':'positionB']||0);
        setTimeout(()=>{
          if(generation!==playbackVerification)return;
          const after=mixer.localStatus?.()||{};
          const playing=after[unit===1?'playingA':'playingB']===true;
          const error=after[unit===1?'errorA':'errorB']===true;
          const position=Number(after[unit===1?'positionA':'positionB']||0);
          diagnostics.audioOutcome={at:new Date().toISOString(),deck:unit,
            playing,error,position,advancedSeconds:Math.max(0,position-before)};
          if(error)output('FLX4 PLAY received · local audio file failed to load');
          else if(playing)output('FLX4 PLAY confirmed · Deck '+(unit===1?'A':'B')+' is playing');
          else if(position>before+0.1)output('FLX4 PLAY received · deck paused');
          else output('FLX4 PLAY received · no audio motion (check source and output)');
        },1800);
      }
      return ok;
    }
    return false;
  }
  function connect(){
    if(!enabled||socket)return;
    try{
      socket=new WebSocket(wsUrl);
      socket.addEventListener('open',()=>{
        ready=true;
        output('MIDI bridge connected · checking physical FLX4');
        try{socket.send(JSON.stringify({type:'status_request'}));}catch{}
      });
      socket.addEventListener('message',message=>{
        try{
          const event=JSON.parse(message.data);
          diagnostics.messages++;
          if(event.action==='controller_status'){
            midiConnected=event.status?.physical_controller_monitor?.connected===true;
            output(midiConnected?'FLX4 READY · turn browse, LOAD or PLAY':'FLX4 USB/MIDI not connected');
            return;
          }
          if(event.source===SOURCE){
            diagnostics.hardwareMessages++;
            midiConnected=true;
            // Show MIDI receipt even if native Rekordbox currently owns a
            // verified loaded deck, rather than silently ignoring gestures.
            if(!allowed()){record(event,false,'verified Rekordbox deck in use');output('FLX4 press received · Rekordbox deck in use');return;}
            processPhysical(event);
          }
        }catch(error){diagnostics.lastError=String(error?.stack||error).slice(0,450);output('Controller event failed: '+String(error?.message||error).slice(0,55));}
      });
      socket.addEventListener('close',()=>{
        socket=null;ready=false;midiConnected=false;
        if(enabled){output('Waiting for FLX4 MIDI bridge…');retry=setTimeout(connect,1800);}
      });
      socket.addEventListener('error',()=>{try{socket.close();}catch{}});
    }catch{socket=null;ready=false;output('FLX4 MIDI bridge unavailable');}
  }
  function toggle(){
    enabled=!enabled;
    if(enabled){connect();output('Connecting to the physical FLX4…');}
    else{
      if(retry){clearTimeout(retry);retry=null;}
      if(socket){socket.close();socket=null;}
      ready=false;midiConnected=false;output('FLX4 controls disabled');
    }
  }
  async function selfTest(){
    const c=controller(),m=deck();
    const result={startedAt:new Date().toISOString(),midiSocketOpen:ready,
      selected:c?.selectedId?.()||null,attempted:false,playing:false,
      browseFunctional:false,loadFunctional:false,
      advancedSeconds:0,success:false,reason:''};
    try{
      if(!ready||!enabled){result.reason='FLX4 connection is not enabled and open';return result;}
      if(!c||!m){result.reason='Music Hub library or audio player not ready';return result;}
      if(!allowed()){result.reason='Verified Rekordbox deck prevents separate local playback';return result;}
      const before=m.localStatus();
      if(before.playingA||before.playingB){
        result.reason='Other local audio is already playing; test did not interfere';
        return result;
      }
      // Existing staged decks can play even if an asynchronous library view
      // has no selected row. That was the cause of the first false failure.
      let id=before.deckA||c.selectedId?.()||c.firstPlayableId?.();
      if(!id){result.reason='No staged deck and no playable songs in loaded library';return result;}
      if(c.select?.(id)){
        const previous=c.selectedId?.();
        if(c.browse?.(1)===true && c.selectedId?.()!==previous)
          result.browseFunctional=true;
        c.select?.(id);
      }
      if(!before.deckA&&(!c.select?.(id)||!c.stage?.(1,id))){
        result.reason='Could not select and stage valid track';return result;
      }
      result.loadFunctional=m.localStatus?.()?.deckA===id;
      result.selected=id;
      const initial=m.localStatus?.()||{};
      const starting=Number(initial.positionA||0);
      const accepted=processPhysical({source:SOURCE,action:'hardware_button',
        deck:1,control:'play',pressed:true,diagnosticTest:true});
      result.attempted=accepted;
      if(!accepted){result.reason='Physical PLAY handler rejected the test';return result;}
      await new Promise(resolve=>setTimeout(resolve,4400));
      const playing=m.localStatus?.()||{};
      result.playing=playing.playingA===true;
      result.advancedSeconds=Math.max(0,Number(playing.positionA||0)-starting);
      result.success=result.playing&&result.advancedSeconds>.65;
      result.reason=result.success?'Real browser audio clock advancing':'Audio play requested but the decoded playhead did not advance';
      if(playing.playingA)m.playDeck(1); // Leave speakers stopped after short test.
      return result;
    }catch(error){
      result.reason=String(error?.message||error).slice(0,170);
      return result;
    }finally{
      result.endedAt=new Date().toISOString();
      diagnostics.selfTest=result;
      output(result.success?'FLX4 self-test PASS: decoded song played':
        'FLX4 self-test FAILED: '+result.reason);
    }
  }
  function init(){
    // Library Focus hides .performance-top and the main toolbar. Keep a small
    // FLX4 control in the sidebar footer without overlaying the song library.
    if($('physical-flx4-toggle'))return;
    const panel=document.createElement('section');
    panel.id='physical-flx4-panel';panel.className='physical-flx4-panel';
    panel.setAttribute('aria-label','Physical FLX4 controller connection');
    const indicator=document.createElement('span');
    indicator.id='physical-flx4-dot';indicator.className='physical-flx4-dot';
    indicator.setAttribute('aria-hidden','true');
    const button=document.createElement('button');
    button.id='physical-flx4-toggle';button.type='button';button.className='physical-flx4-toggle';
    button.textContent='FLX4 · ON';button.setAttribute('aria-pressed','true');
    const status=document.createElement('small');status.id='physical-flx4-status';
    status.className='physical-flx4-status';status.setAttribute('role','status');
    status.textContent='Connecting to the physical DDJ-FLX4…';
    const mode=document.createElement('small');mode.id='physical-flx4-pad-mode';
    mode.className='physical-flx4-status';mode.textContent='Pads · HOT CUE';
    const sweep=document.createElement('small');sweep.id='physical-flx4-sweep';
    sweep.className='physical-flx4-status';
    sweep.textContent='Physical fader test: LEFT ○  CENTER ○  RIGHT ○';
    panel.append(indicator,button,status,mode,sweep);
    (document.querySelector?.('.sidebar-bottom')||document.body).append(panel);
    button.addEventListener('click',toggle);
    output('Connecting to the physical DDJ-FLX4…');
    connect();
    void refreshStandaloneSampler();
    if(typeof setInterval==='function')setInterval(refreshStandaloneSampler,4000);
  }
  window.MusicHubPhysicalFLX4={init,processPhysical,selfTest,
    status:()=>({
      enabled,ready,midiConnected,...diagnostics,
      selectedTrack:controller()?.selectedId?.()||null,
      library:controller()?.libraryDiagnostics?.()||null,
      verified:controller()?.verified?.()||null,
      preview:deck()?.localStatus?.()||null,
      padModes:{...padModes},standaloneSampler:{...standaloneSampler},
      headphone:{...headphone},shiftHeld:{...shiftHeld},
      label:$('physical-flx4-status')?.textContent||null
    }),enable:()=>{if(!enabled)toggle();}};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});
  else init();
})();
