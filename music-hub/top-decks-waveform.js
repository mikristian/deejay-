/* Shared, zoomed beat-lane waveform for the Music Hub performance header. */
(() => {
  'use strict';
  const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
  const finite=n=>typeof n==='number'&&Number.isFinite(n);
  const slots=[null,null];
  const scrubRows=[null,null],deckPreviewAudio=[null,null];
  let expandedWaveDrag=null;
  const savedMarkers=new Map(),markerRequests=new Set();
  let canvas,ctx,strip,button,focusButton,styleButton,collapsed=false,observer,panelObserver;
  let localCrossfade=.5,fadeTimer=null,fadeStarted=0,fadeSource=-1,fadePending=false,fadeRun=0;
  let mixContext=null,mixMaster=null,mixControls=null,transportFrame=0,transportLastFrame=0;
  const channelFaders=[1,1],deckEQ=[{low:.5,mid:.5,high:.5},{low:.5,mid:.5,high:.5}];
  const deckFilters=[.5,.5],deckTempo=[.5,.5],headphoneCue=[false,false];
  let masterLevel=1,headphoneMix=.5,headphoneLevel=1;
  const deckTrim=[.5,.5];
  // Measurements are WebKit/audio-clock latency, not proof of audible DAC output.
  const nowMs=()=>typeof performance!=='undefined'&&typeof performance.now==='function'
    ?performance.now():Date.now();
  const recentPlayMetrics=[null,null];
  function observePlayProgress(index){
    const entry=deckPreviewAudio[index],measure=entry?.playMeasure;
    if(!entry||!measure||measure.firstAdvanceMs!==null||entry.audio.paused)return;
    const current=Number(entry.audio.currentTime);
    if(Number.isFinite(current)&&current>measure.startPosition+.025){
      measure.firstAdvanceMs=Math.max(0,Math.round((nowMs()-measure.requestedAt)*10)/10);
      measure.firstAdvanceSeconds=Math.round((current-measure.startPosition)*1000)/1000;
      recentPlayMetrics[index]={...measure};
    }
  }
  const deckIndex=deck=>deck===1||deck==='1'||deck==='A'||deck==='a'?0:deck===2||deck==='2'||deck==='B'||deck==='b'?1:-1;
  const PARAM_TIME=.008;
  function setAudioParam(param,value){
    if(!param)return;
    if(mixContext&&typeof param.setTargetAtTime==='function')param.setTargetAtTime(value,mixContext.currentTime,PARAM_TIME);
    else param.value=value;
  }
  function updateFilters(index){
    const entry=deckPreviewAudio[index];if(!entry?.lowPass||!entry?.highPass)return;
    const v=deckFilters[index];
    // At center both filters are effectively bypassed. Left cuts highs;
    // right cuts lows. Log sweeps avoid the perceived jump of linear Hz.
    setAudioParam(entry.lowPass.frequency,v<.5?180*Math.pow(100,(v/.5)):20000);
    setAudioParam(entry.highPass.frequency,v>.5?20*Math.pow(400,(v-.5)/.5):20);
  }
  function updateEQ(index){
    const entry=deckPreviewAudio[index];if(!entry?.eqNodes)return;
    for(const [i,band] of ['low','mid','high'].entries()){
      setAudioParam(entry.eqNodes[i].gain,(deckEQ[index][band]-.5)*24);
    }
  }
  const STYLE_KEY='music-hub-expanded-waveform-style-v1';
  let waveformStyle='palette';
  const colors={background:'#030509',blue:'#266bff',amber:'#ffa83d',cream:'#fff3dc',
    tick:'#394352',playhead:'#bac6d8',label:'#4190ff'};
  // A measured beat grid for the compact dual waveform; zoom remains fixed
  // until live deck position feedback actually supplies a time coordinate.
  const BEAT_PX=64;
  const beatTime=b=>finite(b)?b:finite(b?.time)?b.time:NaN;
  const clock=seconds=>{
    if(!finite(seconds)||seconds<0)return '—:—';
    const whole=Math.floor(seconds),mins=Math.floor(whole/60),secs=String(whole%60).padStart(2,'0');
    return mins>=60?`${Math.floor(mins/60)}:${String(mins%60).padStart(2,'0')}:${secs}`:`${mins}:${secs}`;
  };

  function createScrubRows(){
    // The actual mini waveform carries the thin position line; preserve an
    // off-screen range for keyboard-accessible seek without a separate bar.
    const style=document.createElement('style');
    style.textContent='.top-decks-scrub-range{position:absolute!important;width:1px!important;height:1px!important;min-width:0!important;padding:0!important;margin:0!important;border:0!important;overflow:hidden!important;clip-path:inset(50%)!important;white-space:nowrap!important;opacity:0!important}.top-decks-mini-position{position:absolute;z-index:2;width:2px;background:#fff;box-shadow:0 0 2px #fff7;pointer-events:none;box-sizing:border-box}.deck:has(.top-decks-scrub-range:focus-visible) .top-decks-mini-position{outline:1px solid #89c8ff;outline-offset:2px}';
    strip.append(style);
    for(let i=0;i<2;i++){
      const row=document.createElement('div');
      row.className='top-decks-scrub-row';
      row.id=`top-decks-scrub-row-${i+1}`;
      row.style.cssText='display:flex;align-items:center;justify-content:flex-start;gap:6px;padding:0 4px;box-sizing:border-box;min-width:0;min-height:20px;width:100%;';
      const play=document.createElement('button');
      play.type='button';play.id=`top-decks-preview-play-${i+1}`;play.className='top-decks-preview-play';
      play.style.cssText='cursor:pointer;color:#f8fbff;border:1px solid #47566b;border-radius:3px;background:#111b2a;font:700 10px/14px system-ui,sans-serif;width:20px;height:19px;padding:0;flex:none;';
      play.textContent='▶';play.setAttribute('aria-label',`Play local preview on Deck ${i===0?'A':'B'}`);
      play.addEventListener('click',()=>toggleDeckPreview(i));
      const current=document.createElement('span');
      current.className='top-decks-scrub-current';
      current.style.cssText='font:700 9px/19px ui-monospace,SFMono-Regular,monospace;color:#fff;white-space:nowrap;min-width:30px;text-align:right;';
      const range=document.createElement('input');
      range.type='range';range.className='top-decks-scrub-range';range.id=`top-decks-seek-${i+1}`;
      range.min='0';range.max='1000';range.step='1';range.value='0';
      range.style.cssText='position:absolute;width:1px;height:1px;padding:0;margin:0;opacity:0;';
      range.setAttribute('aria-label',`Seek Deck ${i===0?'A':'B'} local audio preview`);
      range.addEventListener('input',()=>seekDeck(i,Number(range.value)/1000));
      const duration=document.createElement('span');
      duration.className='top-decks-scrub-duration';
      duration.style.cssText='font:700 9px/19px ui-monospace,SFMono-Regular,monospace;color:#d6e0ef;white-space:nowrap;min-width:30px;';
      row.append(play,current,range,duration);
      const deckWave=document.getElementById(i===0?'deck-one-wave':'deck-two-wave');
      let marker=null;
      if(deckWave){
        deckWave.after(row);
        marker=document.createElement('span');
        marker.className='top-decks-mini-position';
        marker.id=`top-decks-mini-position-${i+1}`;
        marker.setAttribute('aria-hidden','true');
        deckWave.after(marker);
        deckWave.style.cursor='crosshair';
        deckWave.style.touchAction='none';
        deckWave.title='Click or drag the waveform to seek through this deck\'s local audio';
        const locate=event=>{
          const bounds=deckWave.getBoundingClientRect();
          if(!(bounds.width>0))return false;
          const moved=seekDeck(i,clamp((event.clientX-bounds.left)/bounds.width,0,1));
          if(moved)event.preventDefault();
          return moved;
        };
        let activePointer=null;
        deckWave.addEventListener('pointerdown',event=>{
          if(event.button!==undefined&&event.button!==0)return;
          if(!locate(event))return;
          activePointer=event.pointerId??'mouse';
          try{deckWave.setPointerCapture?.(event.pointerId);}catch{}
        });
        deckWave.addEventListener('pointermove',event=>{
          if(activePointer!==null&&(event.pointerId??'mouse')===activePointer)locate(event);
        });
        const release=event=>{
          if(activePointer===null||(event.pointerId??'mouse')!==activePointer)return;
          activePointer=null;
          try{deckWave.releasePointerCapture?.(event.pointerId);}catch{}
        };
        deckWave.addEventListener('pointerup',release);
        deckWave.addEventListener('pointercancel',release);
        deckWave.addEventListener('lostpointercapture',()=>{activePointer=null;});
      }else strip.append(row);
      scrubRows[i]={row,play,current,range,duration,deckWave,marker};
    }
    syncScrubRows();
  }
  function updateMiniPosition(controls,slot){
    const line=controls?.marker,wave=controls?.deckWave;
    if(!line||!wave)return;
    const deck=wave.closest?.('.deck');
    const waveBox=wave.getBoundingClientRect?.(),deckBox=deck?.getBoundingClientRect?.();
    if(!slot||!finite(slot.position)||!(slot.duration>0)||!waveBox?.width||!waveBox?.height||!deckBox){
      line.hidden=true;return;
    }
    line.hidden=false;
    line.style.left=`${waveBox.left-deckBox.left+clamp(slot.position/slot.duration,0,1)*Math.max(0,waveBox.width-2)}px`;
    line.style.top=`${waveBox.top-deckBox.top+2}px`;
    line.style.height=`${Math.max(1,waveBox.height-4)}px`;
  }

  function createExpandedWaveDrag(){
    if(!canvas)return;
    canvas.style.cursor='grab';
    canvas.style.touchAction='none';
    canvas.title='Grab and drag a waveform left or right to scrub that deck\'s local audio';
    canvas.addEventListener('pointerdown',event=>{
      if(collapsed||(event.button!==undefined&&event.button!==0))return;
      const bounds=canvas.getBoundingClientRect();
      if(!(bounds.width>0&&bounds.height>0))return;
      const index=clamp(Math.floor((event.clientY-bounds.top)/bounds.height*2),0,1);
      const slot=slots[index];
      if(!slot||slot.verified||!finite(slot.position)||!(slot.duration>0))return;
      expandedWaveDrag={pointerId:event.pointerId??'mouse',index,
        startX:event.clientX,startPosition:slot.position,trackId:slot.trackId,
        pxPerSecond:slot.bpm>0?BEAT_PX*slot.bpm/60:120};
      canvas.style.cursor='grabbing';
      try{canvas.setPointerCapture?.(event.pointerId);}catch{}
      event.preventDefault();
    });
    canvas.addEventListener('pointermove',event=>{
      const drag=expandedWaveDrag;
      if(!drag||(event.pointerId??'mouse')!==drag.pointerId)return;
      const slot=slots[drag.index];
      if(!slot||slot.verified||slot.trackId!==drag.trackId){expandedWaveDrag=null;canvas.style.cursor='grab';return;}
      const delta=event.clientX-drag.startX;
      // The waveform follows the hand; the fixed time coordinate beneath it
      // moves in the opposite direction, just as in rekordbox.
      if(Math.abs(delta)>=1&&seekDeck(drag.index,clamp((drag.startPosition-delta/drag.pxPerSecond)/slot.duration,0,1)))event.preventDefault();
    });
    const release=event=>{
      if(!expandedWaveDrag||(event.pointerId??'mouse')!==expandedWaveDrag.pointerId)return;
      expandedWaveDrag=null;
      canvas.style.cursor='grab';
      try{canvas.releasePointerCapture?.(event.pointerId);}catch{}
    };
    canvas.addEventListener('pointerup',release);
    canvas.addEventListener('pointercancel',release);
    canvas.addEventListener('lostpointercapture',()=>{expandedWaveDrag=null;canvas.style.cursor='grab';});
  }
  function createLocalMixer(){
    const mini=document.querySelector?.('#performance-panel .mini-mixer');
    if(!mini||document.getElementById('top-decks-local-mix'))return;
    const section=document.createElement('div');
    section.className='top-decks-local-mix';section.id='top-decks-local-mix';
    section.innerHTML='<span class="local-mix-label">LOCAL MIX</span><input id="top-decks-crossfade" aria-label="Local deck crossfader, Deck A left and Deck B right" type="range" min="0" max="100" step="1" value="50"><div class="local-mix-actions"><button id="top-decks-auto-fade" type="button">AUTO FADE</button><span id="top-decks-mix-status" role="status">Local audio only</span></div>';
    mini.prepend(section);
    const fader=section.querySelector('#top-decks-crossfade');
    const auto=section.querySelector('#top-decks-auto-fade');
    fader?.addEventListener('input',()=>{stopAutoFade();setCrossfade(Number(fader.value)/100);});
    auto?.addEventListener('click',()=>autoTransition());
    mixControls={section,fader,auto,status:section.querySelector('#top-decks-mix-status')};
    setCrossfade(.5);
  }
  function crossfadeVolumes(){
    const theta=localCrossfade*Math.PI/2;
    return [Math.cos(theta),Math.sin(theta)];
  }
  function applyMixVolumes(){
    const levels=crossfadeVolumes();
    for(let i=0;i<2;i++){
      const entry=deckPreviewAudio[i];
      if(!entry)continue;
      const level=levels[i]*channelFaders[i];
      if(entry.gainNode&&mixContext){
        entry.audio.volume=1; // HTMLMediaElement attenuation must not be applied twice.
        setAudioParam(entry.gainNode.gain,level);
      }else entry.audio.volume=clamp(level,0,1);
    }
  }
  function setCrossfade(value){
    if(!finite(value))return false;
    localCrossfade=clamp(value,0,1);
    if(mixControls?.fader)mixControls.fader.value=String(Math.round(localCrossfade*100));
    if(mixControls?.status&&!fadeTimer){
      mixControls.status.textContent=localCrossfade<.05?'DECK A':localCrossfade>.95?'DECK B':'A + B';
    }
    applyMixVolumes();return true;
  }
  function setChannelFader(deck,value){
    const index=deckIndex(deck);if(index<0||!finite(value))return false;
    channelFaders[index]=clamp(value,0,1);applyMixVolumes();return true;
  }
  function setMasterLevel(value){
    if(!finite(value))return false;
    masterLevel=clamp(value,0,1);
    setAudioParam(mixMaster?.gain,masterLevel);
    return true;
  }
  function setTrim(deck,value){
    const index=deckIndex(deck);if(index<0||!finite(value))return false;
    deckTrim[index]=clamp(value,0,1);
    // Unity at center; full clockwise gives +6 dB of input gain.
    // Keep trim upstream of EQ and channel faders, like a hardware mixer.
    setAudioParam(deckPreviewAudio[index]?.trimNode?.gain,deckTrim[index]*2);
    return true;
  }
  function setHeadphoneMix(value){
    if(!finite(value))return false;
    headphoneMix=clamp(value,0,1);return true;
  }
  function setHeadphoneLevel(value){
    if(!finite(value))return false;
    headphoneLevel=clamp(value,0,1);return true;
  }
  function setEq(deck,band,value){
    const index=deckIndex(deck),name=String(band||'').toLowerCase();
    if(index<0||!['low','mid','high'].includes(name)||!finite(value))return false;
    deckEQ[index][name]=clamp(value,0,1);updateEQ(index);return true;
  }
  function setFilter(deck,value){
    const index=deckIndex(deck);if(index<0||!finite(value))return false;
    deckFilters[index]=clamp(value,0,1);updateFilters(index);return true;
  }
  function setTempo(deck,value){
    const index=deckIndex(deck);if(index<0||!finite(value))return false;
    deckTempo[index]=clamp(value,0,1);
    // Center detent is exactly 1x; +/- 50% speed at the extremes.
    const audio=deckPreviewAudio[index]?.audio;
    if(audio){audio.playbackRate=.5+deckTempo[index];audio.preservesPitch=true;}
    return true;
  }
  function cueDeck(deck){
    const index=deckIndex(deck),slot=slots[index];
    if(index<0||!slot||slot.verified||!(slot.duration>0))return false;
    const entry=previewEntry(index);if(!entry)return false;
    const cue=clamp(slot.cuePoint??0,0,slot.duration);
    if(!entry.audio.paused){entry.audio.pause();return seekDeck(index,cue/slot.duration);}
    const current=finite(entry.audio.currentTime)?entry.audio.currentTime:slot.position;
    // CUE from a new paused position establishes a new cue; a second press
    // returns to that cue. A press already at cue starts local playback.
    if(Math.abs(current-cue)>.075){slot.cuePoint=current;return true;}
    return toggleDeckPreview(index,true);
  }
  function syncDeck(deck){
    const index=deckIndex(deck),slot=slots[index],other=slots[1-index];
    if(index<0||!slot||slot.verified||!other||other.verified||
       !(slot.bpm>0&&other.bpm>0))return false;
    const otherRate=deckPreviewAudio[1-index]?.audio?.playbackRate??(.5+deckTempo[1-index]);
    const wanted=other.bpm*otherRate/slot.bpm;
    if(!finite(wanted)||wanted<.5||wanted>1.5)return false;
    return setTempo(index+1,wanted-.5);
  }
  function activeSlot(deck){
    const index=deckIndex(deck),slot=slots[index];
    return index<0||!slot||slot.verified||!(slot.duration>0)?null:{index,slot};
  }
  function deckPosition(index){
    const entry=deckPreviewAudio[index];
    return entry&&entry.pendingSeek!==null?entry.pendingSeek:
      finite(entry?.audio?.currentTime)?entry.audio.currentTime:slots[index]?.position??0;
  }
  function seekSeconds(index,seconds){
    const slot=slots[index];return !!slot&&seekDeck(index,clamp(seconds,0,slot.duration)/slot.duration);
  }
  function loopIn(deck){
    const active=activeSlot(deck);if(!active)return false;
    active.slot.loop={start:deckPosition(active.index),end:null,active:false};return true;
  }
  function loopOut(deck){
    const active=activeSlot(deck),loop=active?.slot.loop;
    if(!loop||!finite(loop.start))return false;
    const end=deckPosition(active.index);
    if(end-loop.start<.05)return false;
    Object.assign(loop,{end,active:true});return true;
  }
  function loopFourBeat(deck){
    const active=activeSlot(deck);if(!active||!(active.slot.bpm>0))return false;
    return startBeatLoop(active.index,4);
  }
  function startBeatLoop(index,beats){
    const slot=slots[index];if(!slot||slot.verified||!(slot.bpm>0)||!(beats>0))return false;
    const start=deckPosition(index),end=Math.min(slot.duration,start+beats*60/slot.bpm);
    if(end-start<.05)return false;
    slot.loop={start,end,active:true};return true;
  }
  function loopExit(deck){
    const active=activeSlot(deck);if(!active||!active.slot.loop)return false;
    active.slot.loop=null;return true;
  }
  function resizeLoop(deck,factor){
    const active=activeSlot(deck),loop=active?.slot.loop;
    if(!loop?.active||!(loop.end>loop.start))return false;
    const end=Math.min(active.slot.duration,loop.start+(loop.end-loop.start)*factor);
    if(end-loop.start<.05)return false;
    loop.end=end;
    if(deckPosition(active.index)>=end)seekSeconds(active.index,loop.start);
    return true;
  }
  const loopHalf=deck=>resizeLoop(deck,.5);
  const loopDouble=deck=>resizeLoop(deck,2);
  function enforceLoop(index){
    const slot=slots[index],entry=deckPreviewAudio[index],loop=slot?.loop;
    if(!entry||entry.audio.paused||!loop?.active||!finite(loop.end)||
       !(loop.end>loop.start)||entry.pendingSeek!==null)return;
    const t=entry.audio.currentTime;
    if(finite(t)&&t>=loop.end){
      const overshoot=(t-loop.end)%(loop.end-loop.start);
      seekSeconds(index,loop.start+overshoot);
    }
  }
  function triggerHotCue(deck,pad,shifted=false){
    const active=activeSlot(deck);
    if(!active||!Number.isInteger(pad)||pad<0||pad>7)return false;
    const cues=active.slot.hotCues??(active.slot.hotCues=Array(8).fill(null));
    if(shifted===true){if(cues[pad]===null)return false;cues[pad]=null;return true;}
    if(cues[pad]===null)cues[pad]=deckPosition(active.index);
    return seekSeconds(active.index,cues[pad]);
  }
  function beatJump(deck,pad,shifted=false){
    const active=activeSlot(deck);if(!active||!(active.slot.bpm>0)||!Number.isInteger(pad)||pad<0||pad>7)return false;
    const beats=[-1,-2,-4,-8,1,2,4,8][pad]*(shifted===true?4:1);
    return seekSeconds(active.index,deckPosition(active.index)+beats*60/active.slot.bpm);
  }
  function beatLoop(deck,pad,shifted=false){
    const active=activeSlot(deck);if(!active||!Number.isInteger(pad)||pad<0||pad>7)return false;
    return startBeatLoop(active.index,[.25,.5,1,2,4,8,16,32][pad]*(shifted===true?2:1));
  }
  function jogDeck(deck,delta,mode='nudge'){
    const index=deckIndex(deck),entry=deckPreviewAudio[index],slot=slots[index];
    if(index<0||!finite(delta)||!slot||slot.verified||!(slot.duration>0))return false;
    const current=entry?.audio.currentTime??slot.position??0;
    const seconds=clamp(current+clamp(delta,-100,100)*(mode==='scrub'?.05:.01),0,slot.duration);
    return seekDeck(index,seconds/slot.duration);
  }
  function setHeadphoneCue(deck,on){
    const index=deckIndex(deck);if(index<0||typeof on!=='boolean')return false;
    // Cue state is available for a dedicated routed output. A normal browser
    // stereo destination cannot isolate headphone monitoring from master.
    headphoneCue[index]=on;return true;
  }
  function mixerState(){
    const factors=crossfadeVolumes();
    return {audioContextState:mixContext?.state??'not-created',crossfade:localCrossfade,
      masterLevel,trim:[...deckTrim],headphoneMix,headphoneLevel,
      channelFaders:[...channelFaders],masterGain:factors.map((factor,index)=>factor*channelFaders[index]),
      eq:deckEQ.map(bands=>({...bands})),filters:[...deckFilters],tempo:[...deckTempo],
      headphoneCue:[...headphoneCue],
      playMetrics:recentPlayMetrics.map(item=>item?{...item}:null),
      audioGraphConnected:deckPreviewAudio.map(entry=>!!entry?.gainNode),
      mediaReadyState:deckPreviewAudio.map(entry=>entry?.audio?.readyState??null)};
  }
  function setupMixAudio(entry){
    if(!entry?.audio||entry.gainNode)return;
    const Context=window.AudioContext||window.webkitAudioContext;
    if(!Context){applyMixVolumes();return;}
    try{
      if(!mixContext){mixContext=new Context();mixMaster=mixContext.createGain();mixMaster.connect(mixContext.destination);setAudioParam(mixMaster.gain,masterLevel);}
      const source=mixContext.createMediaElementSource(entry.audio);
      const trimNode=mixContext.createGain();
      const eqLow=mixContext.createBiquadFilter(),eqMid=mixContext.createBiquadFilter(),eqHigh=mixContext.createBiquadFilter();
      eqLow.type='lowshelf';eqLow.frequency.value=250;
      eqMid.type='peaking';eqMid.frequency.value=1100;eqMid.Q.value=.7;
      eqHigh.type='highshelf';eqHigh.frequency.value=4000;
      const highPass=mixContext.createBiquadFilter(),lowPass=mixContext.createBiquadFilter();
      highPass.type='highpass';highPass.frequency.value=20;highPass.Q.value=.707;
      lowPass.type='lowpass';lowPass.frequency.value=20000;lowPass.Q.value=.707;
      const gain=mixContext.createGain();
      source.connect(trimNode);trimNode.connect(eqLow);eqLow.connect(eqMid);eqMid.connect(eqHigh);
      eqHigh.connect(highPass);highPass.connect(lowPass);lowPass.connect(gain);gain.connect(mixMaster);
      entry.gainNode=gain;entry.trimNode=trimNode;entry.eqNodes=[eqLow,eqMid,eqHigh];entry.lowPass=lowPass;entry.highPass=highPass;
      const index=deckPreviewAudio.indexOf(entry);
      if(index>=0){setTrim(index+1,deckTrim[index]);updateEQ(index);updateFilters(index);setTempo(index+1,deckTempo[index]);}
      applyMixVolumes();
      if(mixContext.state==='suspended')mixContext.resume().catch(()=>{});
    }catch{applyMixVolumes();}
  }
  function stopAutoFade(){
    fadeRun++;
    if(fadeTimer!==null){clearInterval(fadeTimer);fadeTimer=null;}
    fadePending=false;
    if(mixControls?.auto)mixControls.auto.textContent='AUTO FADE';
    if(mixControls?.status)mixControls.status.textContent=localCrossfade<=.05?'DECK A':localCrossfade>=.95?'DECK B':'A + B';
  }
  function autoTransition(seconds=8){
    if(!finite(seconds)||seconds<2||seconds>60)return false;
    const playing=deckPreviewAudio.map(entry=>!!entry&&!entry.audio.paused&&!entry.audio.ended);
    const source=playing[0]&&!playing[1]?0:playing[1]&&!playing[0]?1:
      playing[0]&&playing[1]?(localCrossfade<=.5?0:1):-1;
    if(source<0)return false;
    const target=1-source;
    if(!slots[target]||slots[target].verified||!slots[target].duration)return false;
    stopAutoFade();
    const previous=deckPreviewAudio[source];
    if(!previous)return false;
    // All target controls affect decoded, local file audio. No Rekordbox MIDI
    // or connected hardware transport is claimed by this transition.
    setCrossfade(source===0?0:1);
    if(!toggleDeckPreview(target,true))return false;
    const incoming=deckPreviewAudio[target];
    if(!incoming)return false;
    fadePending=true;
    const run=fadeRun;
    if(mixControls?.auto)mixControls.auto.textContent='STARTING…';
    const beginFade=()=>{
      if(!fadePending||run!==fadeRun)return;
      if(deckPreviewAudio[source]!==previous||deckPreviewAudio[target]!==incoming||
          incoming.audio.paused||slots[target]?.verified){stopAutoFade();return;}
      fadeStarted=Date.now();fadeSource=source;
      if(mixControls?.auto)mixControls.auto.textContent='FADING…';
      fadeTimer=setInterval(()=>{
        if(run!==fadeRun||deckPreviewAudio[source]!==previous||deckPreviewAudio[target]!==incoming||
            incoming.audio.paused||!slots[target]||slots[target].verified){
          stopAutoFade();return;
        }
        const p=clamp((Date.now()-fadeStarted)/(seconds*1000),0,1);
        setCrossfade(source===0?p:1-p);
        if(p>=1){stopAutoFade();previous.audio.pause();}
      },40);
    };
    Promise.resolve(incoming.lastPlayPromise).then(beginFade,()=>stopAutoFade());
    return true;
  }
  function fadeTo(target,seconds=2){
    if(!finite(target)||target<0||target>1||!finite(seconds)||seconds<.1||seconds>30)return false;
    stopAutoFade();
    const start=localCrossfade,begin=Date.now();
    if(mixControls?.auto)mixControls.auto.textContent='FADING…';
    fadeTimer=setInterval(()=>{
      const p=clamp((Date.now()-begin)/(seconds*1000),0,1);
      setCrossfade(start+(target-start)*p);
      if(p>=1)stopAutoFade();
    },40);
    return true;
  }
  function transportTick(timestamp){
    transportFrame=0;
    const active=deckPreviewAudio.some(e=>e&&!e.audio.paused&&!e.audio.ended);
    if(!active)return;
    for(let i=0;i<2;i++)enforceLoop(i);
    if(timestamp-transportLastFrame>=50){
      transportLastFrame=timestamp;
      for(let i=0;i<2;i++){
        const entry=deckPreviewAudio[i],slot=slots[i];
        if(entry&&slot&&!slot.verified&&entry.trackId===slot.trackId&&
           entry.pendingSeek===null&&finite(entry.audio.currentTime)){
          slot.position=clamp(entry.audio.currentTime,0,slot.duration);
          observePlayProgress(i);
        }
      }
      render();
    }
    transportFrame=window.requestAnimationFrame?.(transportTick)||0;
  }
  function ensureTransportTick(){
    if(!transportFrame&&window.requestAnimationFrame)transportFrame=window.requestAnimationFrame(transportTick);
  }

  function init(){
    const panel=document.getElementById('performance-panel');
    if(!panel||document.getElementById('top-decks-wave-strip'))return;
    strip=document.createElement('div');
    strip.className='top-decks-wave-strip';
    strip.id='top-decks-wave-strip';
    strip.innerHTML='<button type="button" class="top-decks-wave-expand" id="top-decks-wave-expand" aria-label="Collapse both waveform lanes" aria-controls="top-decks-wave-canvas" aria-expanded="true" aria-keyshortcuts="Alt+W" title="Collapse both waveform lanes (Alt+W)">‹</button><canvas id="top-decks-wave-canvas" role="img" aria-label="Two beat-aligned, analyzed waveform lanes for staged or verified deck tracks"></canvas><span class="top-decks-wave-collapsed-hint" aria-hidden="true">WAVEFORMS COLLAPSED · › TO EXPAND</span>';
    panel.querySelector('.deck-pair')?.before(strip);
    canvas=document.getElementById('top-decks-wave-canvas');
    button=document.getElementById('top-decks-wave-expand');
    ctx=canvas?.getContext('2d');
    createExpandedWaveDrag();
    createScrubRows();
    createLocalMixer();
    try{waveformStyle=localStorage.getItem(STYLE_KEY)==='rgb'?'rgb':'palette';}catch{}
    styleButton=document.createElement('button');
    styleButton.type='button';
    styleButton.id='top-decks-wave-style';
    styleButton.className='top-decks-wave-style';
    styleButton.addEventListener('click',()=>setWaveformStyle(waveformStyle==='palette'?'rgb':'palette'));
    // The native color-style control belongs in the performance toolbar.
    // Placing it over lane A obscured the "NO ANALYZED WAVEFORM" label.
    panel.querySelector('.performance-top')?.append(styleButton);
    updateStyleButton();
    // Inline sizing overrides the older 190px stylesheet rule. A theme can
    // supply --pc-wave-height; expansion uses a roomier fallback only.
    canvas.style.height='100%';
    focusButton=document.createElement('button');
    focusButton.type='button';focusButton.id='library-focus-toggle';focusButton.className='library-focus-toggle';
    focusButton.title='Collapse only the two waveform lanes, keeping Up Next separately controllable';
    panel.querySelector('.performance-top')?.append(focusButton);
    focusButton.addEventListener('click',()=>setCompact(!collapsed));
    button?.addEventListener('click',()=>setCompact(!collapsed));
    let saved=false;
    try{const current=localStorage.getItem('music-hub-waveforms-collapsed-v2');saved=current===null?localStorage.getItem('music-hub-library-focus-v1')==='true':current==='true';}catch{}
    setCompact(saved,false);
    // The little arrow is independently keyboard-operable. This shortcut
    // affects only the two waveform lanes, never Up Next recommendations.
    document.addEventListener('keydown',event=>{
      // Option+W produces a different printable glyph on many Mac keyboard
      // layouts. `code` (physical W key) retains the intended shortcut.
      if(event.altKey&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&(event.code==='KeyW'||event.key.toLowerCase()==='w')){
        if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)||document.activeElement?.isContentEditable)return;
        event.preventDefault();setCompact(!collapsed);
      }
    });
    if(typeof ResizeObserver==='function'){
      observer=new ResizeObserver(render);
      observer.observe(strip);
    }
    if(typeof MutationObserver==='function'){
      panelObserver=new MutationObserver(render);
      panelObserver.observe(panel,{attributes:true,attributeFilter:['class']});
    }
    window.addEventListener('resize',render);
    render();
  }

  function setCompact(enabled,save=true){
    collapsed=Boolean(enabled);
    strip?.classList.toggle('collapsed',collapsed);
    // The compact deck timeline remains available even when zoomed lanes fold.
    for(const controls of scrubRows)if(controls)controls.row.style.display='flex';
    if(styleButton)styleButton.hidden=collapsed;
    // Do not modify Up Next here: it now has its own arrow and saved state.
    if(button){button.setAttribute('aria-expanded',String(!collapsed));button.setAttribute('aria-label',collapsed?'Expand both waveform lanes':'Collapse both waveform lanes');button.textContent=collapsed?'›':'‹';button.title=collapsed?'Expand both waveform lanes (Alt+W)':'Collapse both waveform lanes (Alt+W)';}
    if(focusButton){focusButton.textContent=collapsed?'SHOW WAVEFORMS':'HIDE WAVEFORMS';focusButton.setAttribute('aria-pressed',String(collapsed));focusButton.title=collapsed?'Expand both stacked waveform lanes':'Collapse both stacked waveform lanes without hiding Up Next';}
    if(save)try{localStorage.setItem('music-hub-waveforms-collapsed-v2',String(collapsed));}catch{}
    render();
  }
  function updateStyleButton(){
    if(!styleButton)return;
    const palette=waveformStyle==='palette';
    styleButton.textContent=palette?'3-BAND COLOR':'ANALYSIS RGB';
    styleButton.title=palette?'Palette-styled measured amplitude (blue, orange, ivory). Click for recorded analysis colors.':'Recorded Rekordbox analysis colors. Click for blue, orange, ivory palette.';
    styleButton.setAttribute('aria-label',`Waveform color style: ${palette?'3-band color palette':'analysis RGB'}. Activate to switch to ${palette?'analysis RGB':'3-band color palette'}.`);
    styleButton.setAttribute('aria-pressed',String(!palette));
  }
  function setWaveformStyle(style){
    waveformStyle=style==='rgb'?'rgb':'palette';
    try{localStorage.setItem(STYLE_KEY,waveformStyle);}catch{}
    updateStyleButton();render();
  }

  function getPeaks(detail){
    const raw=detail?.waveform?.heights;
    if(!Array.isArray(raw)||raw.length<2)return null;
    const values=raw.map(v=>Array.isArray(v)?Math.max(0,...v.map(x=>Number(x)||0)):Math.max(0,Number(v)||0));
    const nonzero=values.filter(v=>v>0).sort((a,b)=>a-b);
    const p95=nonzero[Math.floor(nonzero.length*.95)]||1;
    const rawColors=detail?.waveform?.colors;
    const rgb=Array.isArray(rawColors)&&rawColors.length===raw.length?
      rawColors.map(c=>Array.isArray(c)&&c.length>=3&&c.slice(0,3).every(v=>finite(v)&&v>=0&&v<=255)?c.slice(0,3):null):null;
    return {values,scale:p95,rgb};
  }
  function sample(peaks,position,duration){
    if(!peaks||!(duration>0)||position<0||position>duration)return 0;
    const idx=clamp(position/duration*(peaks.values.length-1),0,peaks.values.length-1);
    const first=Math.floor(idx),fraction=idx-first;
    const value=peaks.values[first]*(1-fraction)+(peaks.values[Math.min(first+1,peaks.values.length-1)]*fraction);
    return clamp(value/peaks.scale,0,1);
  }
  function drawBeatTick(x,top,bottom){
    const inset=Math.min(5,Math.max(2,(bottom-top)*.12));
    ctx.strokeStyle=colors.tick;ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(x+.5,top+inset);ctx.lineTo(x+.5,bottom-inset);
    ctx.moveTo(x-3,top+inset+.5);ctx.lineTo(x+3,top+inset+.5);
    ctx.moveTo(x-3,bottom-inset+.5);ctx.lineTo(x+3,bottom-inset+.5);ctx.stroke();
  }
  function drawMeasuredWave(peaks,slot,playX,pxPerSecond,y,width,laneHeight){
    if(!peaks||!slot.duration)return;
    // Both styles show the same measured amplitude envelope. The default
    // three-color overlay is a visual palette, NOT independent frequency data.
    const start=Math.max(0,Math.floor(playX-slot.position*pxPerSecond));
    for(let x=start;x<width;x++){
      const time=slot.position+(x-playX)/pxPerSecond;
      if(time<0||time>slot.duration)continue;
      const amplitude=sample(peaks,time,slot.duration);
      if(amplitude<=.003)continue;
      const half=Math.max(.6,amplitude*Math.max(2,laneHeight*.40));
      if(waveformStyle==='rgb'){
        const colorIndex=clamp(Math.round(time/slot.duration*(peaks.values.length-1)),0,peaks.values.length-1);
        const color=peaks.rgb?.[colorIndex];
        ctx.fillStyle=color?`rgb(${color[0]},${color[1]},${color[2]})`:colors.blue;
        ctx.fillRect(x,y-half,1,half*2);
      }else{
        for(const [ratio,color] of [[1,colors.blue],[.68,colors.amber],[.29,colors.cream]]){
          const band=Math.max(.5,half*ratio);
          ctx.fillStyle=color;
          ctx.fillRect(x,y-band,1,band*2);
        }
      }
    }
  }
  function drawCueTicks(slot,playX,pxPerSecond,top,bottom,width){
    const cues=slot.detail?.cues?.cues;
    const existing=Array.isArray(cues)?cues.map(cue=>({timeMs:cue?.in_ms,source:'rekordbox'})):[];
    const own=Array.isArray(slot.markers)?slot.markers.filter(marker=>marker?.source==='user'):[];
    for(const cue of [...existing,...own]){
      const ms=Number(cue.timeMs);
      if(!Number.isFinite(ms)||ms<0)continue;
      const x=playX+(ms/1000-slot.position)*pxPerSecond;
      if(x<0||x>width)continue;
      ctx.fillStyle=cue.source==='user'&&/^#[0-9a-fA-F]{6}$/.test(cue.color)?cue.color:'#e6d08a';
      ctx.fillRect(Math.floor(x),top+3,2,bottom-top-6);
      ctx.beginPath();ctx.moveTo(x-4,top+3);ctx.lineTo(x+5,top+3);ctx.lineTo(x,top+10);ctx.closePath();ctx.fill();
    }
  }
  function loadSavedMarkers(trackId){
    if(!/^\d{1,20}$/.test(trackId)||savedMarkers.has(trackId)||markerRequests.has(trackId))return;
    markerRequests.add(trackId);
    fetch('/api/music-hub/markers?trackId='+encodeURIComponent(trackId),{cache:'no-store'})
      .then(async response=>{if(!response.ok)throw Error('Marker request failed');return response.json();})
      .then(data=>{
        const markers=Array.isArray(data.markers)?data.markers.filter(m=>m?.source==='user'):[];
        savedMarkers.set(trackId,markers);
        for(const slot of slots)if(slot?.trackId===trackId)slot.markers=markers;
        render();
      })
      .catch(()=>{})
      .finally(()=>markerRequests.delete(trackId));
  }
  function beatGrid(slot,start,end){
    const beats=slot.detail?.analysis?.beats;
    const explicit=Array.isArray(beats)?beats.map(beatTime).filter(Number.isFinite).sort((a,b)=>a-b):[];
    // Never invent beat locations using BPM alone: a steady inferred grid
    // would imply analyzed beat alignment on tracks with missing beat data.
    return explicit.filter(t=>t>=start-1&&t<=end+1);
  }
  function barLabel(slot){
    if(!slot||slot.position===null)return '—';
    const beats=Array.isArray(slot.detail?.analysis?.beats)?slot.detail.analysis.beats:[];
    if(!beats.length)return '—';
    const current=beats.findLastIndex(b=>finite(b?.time)&&b.time<=slot.position);
    if(current<0)return '1.1Bars';
    const downbeats=beats.slice(0,current+1).filter(b=>b?.beat===1).length;
    const suppliedBeat=Number(beats[current]?.beat);
    if(Number.isInteger(suppliedBeat)&&suppliedBeat>=1&&suppliedBeat<=4&&downbeats>0)
      return `${downbeats}.${suppliedBeat}Bars`;
    return '—'; // Unknown meter or incomplete beat indices: do not invent bars.
  }
  function previewLabel(slot){
    if(!slot?.localPreview)return 'STAGED PREVIEW · 0:00';
    const seconds=Math.floor(Math.max(0,slot.position));
    const time=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
    if(slot.localPreview.error)return 'LOCAL AUDIO UNAVAILABLE';
    if(slot.localPreview.pending)return `CUE REQUESTED · ${time}`;
    const engine=slot.localPreview.source==='rust'?'RUST AUDIO':'LOCAL PREVIEW';
    return engine+' · '+time+(slot.localPreview.playing?'':' · PAUSED');
  }
  function syncScrubRows(){
    for(let i=0;i<2;i++){
      const controls=scrubRows[i],slot=slots[i];
      if(!controls)continue;
      const duration=slot?.duration>0?slot.duration:0;
      const position=finite(slot?.position)?clamp(slot.position,0,duration):null;
      const available=duration>0&&!slot?.verified;
      const entry=deckPreviewAudio[i],playing=slot?.localPreview?.source==='rust'
        ?slot.localPreview.playing===true
        :entry&&entry.trackId===slot?.trackId&&!entry.audio.paused&&!entry.audio.ended;
      controls.current.textContent=clock(position);
      controls.duration.textContent=clock(duration||null);
      controls.range.value=String(position===null||!duration?0:Math.round(position/duration*1000));
      updateMiniPosition(controls,slot);
      controls.range.disabled=!available;
      controls.play.disabled=!available;
      controls.play.style.opacity=available?'1':'.45';
      controls.play.textContent=playing?'Ⅱ':'▶';
      controls.play.setAttribute('aria-label',`${playing?'Pause':'Play'} local preview on Deck ${i===0?'A':'B'}`);
      const tip=!slot?'Stage a track first':slot.verified?'Rekordbox deck is read-only; live seeking is unavailable':!duration?'Track duration is unavailable':'Seek local preview audio; Rekordbox transport is unaffected';
      controls.range.title=tip;controls.play.title=tip;
      controls.range.setAttribute('aria-valuetext',`${clock(position)} of ${clock(duration||null)}`);
      const native=document.querySelector?.(`#performance-panel [data-pc-deck="${i+1}"] .pc-transport-play`);
      if(native){
        if(native.dataset.localAudioAction!=='true'){
          native.dataset.localAudioAction='true';
          native.addEventListener('click',()=>toggleDeckPreview(i));
        }
        native.disabled=!available;
        native.setAttribute('aria-disabled',String(!available));
        native.setAttribute('aria-label',`${playing?'Pause':'Play'} Deck ${i===0?'A':'B'} local audio`);
        native.title=tip;native.textContent=playing?'Ⅱ':'▶';
      }
      const pcTime=document.querySelector?.(`#performance-panel [data-pc-deck="${i+1}"] .pc-sync-time`);
      if(pcTime&&slot&&!slot.verified)pcTime.textContent=`${clock(position)} / ${clock(duration||null)}`;
      const standardTime=document.getElementById(i===0?'deck-one-time':'deck-two-time');
      if(standardTime&&slot&&!slot.verified)standardTime.textContent=`${clock(position)} / ${clock(duration||null)}`;
      if(slot?.localPreview){
        const source=document.getElementById(i===0?'deck-one-source':'deck-two-source');
        if(source&&!slot.verified)source.textContent=slot.localPreview.error?'LOCAL AUDIO UNAVAILABLE':
          slot.localPreview.playing?'LOCAL AUDIO · PLAYING':'LOCAL AUDIO · PAUSED';
      }
    }
  }
  function releaseDeckPreview(index){
    const entry=deckPreviewAudio[index];if(!entry)return;
    deckPreviewAudio[index]=null;
    stopAutoFade();
    entry.audio.pause();
    // Disconnect orphaned nodes before replacing the HTMLAudioElement.
    try{entry.gainNode?.disconnect();entry.trimNode?.disconnect();entry.lowPass?.disconnect();entry.highPass?.disconnect();
      for(const node of entry.eqNodes||[])node.disconnect();}catch{}
    entry.audio.removeAttribute('src');
    entry.audio.load();
  }
  function previewEntry(index){
    const slot=slots[index];
    if(!slot||slot.verified||!slot.duration||!/^\d{1,20}$/.test(slot.trackId))return null;
    let entry=deckPreviewAudio[index];
    if(entry&&entry.trackId===slot.trackId)return entry;
    releaseDeckPreview(index);
    const audio=document.createElement('audio');
    audio.preload='auto';audio.volume=1;
    entry={audio,trackId:slot.trackId,pendingSeek:null,playState:'not-requested',playError:null};
    deckPreviewAudio[index]=entry;
    const active=()=>deckPreviewAudio[index]===entry&&slots[index]?.trackId===entry.trackId&&!slots[index]?.verified;
    const sync=()=>{
      if(!active())return;
      // Metadata may still be loading after a scrub. Keep the requested cue
      // visibly pending until there is an actual decoded audio position.
      if(entry.pendingSeek!==null&&audio.readyState<1){render();return;}
      const slot=slots[index],current=Number(audio.currentTime);
      if(finite(current)&&current>=0){
        slot.position=clamp(current,0,slot.duration);
        slot.localPreview={playing:!audio.paused&&!audio.ended,source:'deck'};
      }
      render();
    };
    audio.addEventListener('loadedmetadata',()=>{
      if(!active())return;
      if(entry.pendingSeek!==null){
        try{audio.currentTime=clamp(entry.pendingSeek,0,Math.min(slots[index].duration,finite(audio.duration)?audio.duration:slots[index].duration));entry.pendingSeek=null;}catch{}
      }
      sync();
    });
    for(const name of ['timeupdate','seeked','play','pause','ended'])audio.addEventListener(name,()=>{
      if(name==='timeupdate'){
        enforceLoop(index);
        observePlayProgress(index);
      }
      sync();
    });
    audio.addEventListener('playing',()=>{
      const measure=entry.playMeasure;
      if(measure&&measure.playingEventMs===null){
        measure.playingEventMs=Math.max(0,Math.round((nowMs()-measure.requestedAt)*10)/10);
        recentPlayMetrics[index]={...measure};
      }
    });
    audio.addEventListener('play',ensureTransportTick);
    audio.addEventListener('error',()=>{
      if(!active())return;
      slots[index].localPreview={playing:false,error:true};
      controlsError(index);render();
    });
    audio.src='/api/music-hub/audio?id='+encodeURIComponent(slot.trackId);
    // Prime metadata and decode buffers when LOAD stages a file. Waiting
    // until the PLAY press caused intermittent 2+ second startup delays.
    audio.load();
    applyMixVolumes();
    return entry;
  }
  function controlsError(index){
    const controls=scrubRows[index];
    if(slots[index]&&!slots[index].verified)slots[index].localPreview={playing:false,error:true};
    if(controls){controls.play.title='Local audio preview could not be loaded';controls.range.title='Local audio preview unavailable';}
  }
  function seekDeck(index,ratio){
    const slot=slots[index];if(!slot||slot.verified||!(slot.duration>0)||!finite(ratio))return false;
    const seconds=clamp(ratio,0,1)*slot.duration;
    // If the footer's existing local preview is playing this exact file,
    // seek that real audio clock rather than starting a silent duplicate.
    const footer=document.getElementById('preview-audio');
    if(!deckPreviewAudio[index]&&footer?.getAttribute?.('data-track')===slot.trackId&&
       footer.readyState>=1&&finite(footer.duration)&&footer.duration>0){
      try{
        footer.currentTime=clamp(seconds,0,footer.duration);
        syncLocalPreview({trackId:slot.trackId,positionSeconds:footer.currentTime,
          playing:!footer.paused&&!footer.ended});
        return true;
      }catch{}
    }
    const entry=previewEntry(index);
    if(!entry)return false;
    entry.pendingSeek=seconds;
    slot.position=seconds;
    slot.localPreview={playing:false,source:'deck',pending:true};
    if(entry.audio.readyState>=1){
      try{entry.audio.currentTime=clamp(seconds,0,finite(entry.audio.duration)?entry.audio.duration:slot.duration);entry.pendingSeek=null;}catch{}
    }
    render();return true;
  }
  function toggleDeckPreview(index,forcePlay=false){
    const slot=slots[index];if(!slot||slot.verified||!(slot.duration>0))return false;
    const entry=previewEntry(index);if(!entry)return false;
    if(!entry.audio.paused){if(!forcePlay)entry.audio.pause();return true;}
    const footer=document.getElementById('preview-audio');
    if(footer?.getAttribute?.('data-track')===slot.trackId&&!footer.paused){
      entry.pendingSeek=Math.max(0,Number(footer.currentTime)||0);
      footer.pause();
    }
    // PLAY must never grab the crossfader away from a physical FLX4 slider.
    // Rekordbox leaves crossfader positioning under the DJ's control; a
    // silent other deck is not permission to overwrite that control.
    setupMixAudio(entry);
    try{
      entry.playMeasure={
        requestedAt:nowMs(),
        startPosition:Number(entry.audio.currentTime)||0,
        readyStateAtPlay:entry.audio.readyState,
        contextStateAtPlay:mixContext?.state??'no-web-audio',
        playingEventMs:null,
        promiseResolvedMs:null,
        firstAdvanceMs:null,
        firstAdvanceSeconds:null
      };
      recentPlayMetrics[index]={...entry.playMeasure};
      const playing=entry.audio.play();
      entry.lastPlayPromise=playing;
      entry.playState='pending';
      if(playing?.then)playing.then(()=>{
        if(deckPreviewAudio[index]===entry){
          entry.playState='started';entry.playError=null;
          if(entry.playMeasure){
            entry.playMeasure.promiseResolvedMs=Math.max(0,
              Math.round((nowMs()-entry.playMeasure.requestedAt)*10)/10);
            recentPlayMetrics[index]={...entry.playMeasure};
          }
        }
      },error=>{
        if(deckPreviewAudio[index]===entry){
          entry.playState='rejected';entry.playError=String(error?.name||error).slice(0,95);
          controlsError(index);render();
        }
      });
    }catch(error){
      entry.playState='threw';entry.playError=String(error?.name||error).slice(0,95);
      controlsError(index);return false;
    }
    return true;
  }
  function render(){
    if(!canvas||!ctx||!strip)return;
    syncScrubRows();
    const expanded=strip.closest('.performance')?.classList.contains('expanded');
    const desiredHeight=collapsed?26:(expanded?156:88);
    // The collapsed state has its own 26px rule; otherwise allow CSS themes
    // to override the default without depending on the old fixed canvas size.
    const sizing=collapsed?`${desiredHeight}px`:`var(--pc-wave-height, ${desiredHeight}px)`;
    if(strip.style.height!==sizing)strip.style.height=sizing;
    if(strip.style.minHeight!==sizing)strip.style.minHeight=sizing;
    const bounds=canvas.getBoundingClientRect();
    const width=Math.max(1,Math.round(bounds.width||strip.clientWidth||1));
    const height=Math.max(1,Math.round(bounds.height||strip.clientHeight||desiredHeight));
    const dpr=clamp(window.devicePixelRatio||1,1,3);
    if(canvas.width!==Math.round(width*dpr)||canvas.height!==Math.round(height*dpr)){
      canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);
    }
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.fillStyle=colors.background;ctx.fillRect(0,0,width,height);
    if(collapsed)return;
    const playX=Math.round(width*.515)+.5;
    const laneHeight=height/2;
    for(let n=0;n<2;n++){
      const top=n*laneHeight,bottom=top+laneHeight,y=top+laneHeight/2,slot=slots[n];
      ctx.save();ctx.beginPath();ctx.rect(0,top,width,laneHeight);ctx.clip();
      if(slot&&slot.position!==null&&slot.duration>0){
        // A non-BPM view can still render measured amplitude without
        // inventing tempo or beat ticks. Only explicit beat times are marked.
        const pixelsPerSecond=slot.bpm>0?BEAT_PX*slot.bpm/60:120;
        const paddingSeconds=slot.bpm>0?60/slot.bpm:0;
        const secondsAhead=(width-playX)/pixelsPerSecond+paddingSeconds;
        const secondsBehind=playX/pixelsPerSecond+paddingSeconds;
        const beats=beatGrid(slot,slot.position-secondsBehind,slot.position+secondsAhead);
        const peaks=getPeaks(slot.detail);
        // At time zero the visible history is strictly empty.
        if(slot.position<.005){
          ctx.beginPath();ctx.rect(playX,top,width-playX,laneHeight);ctx.clip();
        }
        drawMeasuredWave(peaks,slot,playX,pixelsPerSecond,y,width,laneHeight);
        for(const t of beats){
          const x=playX+(t-slot.position)*pixelsPerSecond;
          if(x>=0&&x<=width){drawBeatTick(x,top,bottom);
            const downbeat=slot.detail?.analysis?.beats?.some(b=>b.time===t&&b.beat===1);
            if(downbeat){ctx.fillStyle='#7d91ac';ctx.fillRect(Math.round(x),top+2,1,6);ctx.fillRect(Math.round(x),bottom-8,1,6);}
          }
        }
        drawCueTicks(slot,playX,pixelsPerSecond,top,bottom,width);
        ctx.restore();ctx.save();ctx.beginPath();ctx.rect(0,top,width,laneHeight);ctx.clip();
      }
      ctx.fillStyle=n===0?'#68c9ff':'#ffb970';
      ctx.font='700 9px -apple-system,BlinkMacSystemFont,sans-serif';
      ctx.fillText(n===0?'A':'B',25,top+13);
      if(!slot?.detail?.waveform?.heights?.length){ctx.fillStyle='#748396';ctx.font='9px sans-serif';ctx.fillText('NO ANALYZED WAVEFORM',42,top+13);}
      if(slot&&!slot.verified){ctx.fillStyle='#8a9bb2';ctx.font='8px sans-serif';ctx.textAlign='right';ctx.fillText(previewLabel(slot),width-8,top+12);ctx.textAlign='start';}
      else if(slot&&slot.position===null){ctx.fillStyle='#8a9bb2';ctx.font='8px sans-serif';ctx.textAlign='right';ctx.fillText('POSITION UNKNOWN',width-8,top+12);ctx.textAlign='start';}
      ctx.strokeStyle='#e3eaf4';ctx.lineWidth=1;
      ctx.strokeStyle='#172536';ctx.beginPath();ctx.moveTo(0,y+.5);ctx.lineTo(width,y+.5);ctx.stroke();
      ctx.font=`700 ${clamp(laneHeight*.27,9,14)}px -apple-system,BlinkMacSystemFont,system-ui,sans-serif`;
      ctx.textAlign='right';ctx.fillStyle=colors.label;
      ctx.fillText(barLabel(slot),playX-10,top+14);ctx.textAlign='start';
      // No playhead or cursor overlays the expanded waveform; the white
      // interactive position indicator lives only in each deck's own timeline.
      ctx.restore();
    }
    ctx.fillStyle='#202836';ctx.fillRect(0,Math.floor(laneHeight),width,1);
  }
  function setDeck(deck,{track,detail,verified=false,positionSeconds=null}={}){
    const index=Number(deck)-1;
    if(index!==0&&index!==1)return;
    if(!track){releaseDeckPreview(index);slots[index]=null;render();return;}
    const duration=Number(track.length??track.duration??detail?.waveform?.duration??0);
    const bpm=Number(track.bpm??track.tempo??detail?.analysis?.beats?.[0]?.bpm??0);
    const trackId=String(track.id??'');
    if(verified||deckPreviewAudio[index]?.trackId!==trackId)releaseDeckPreview(index);
    const previous=slots[index];
    const continuingPreview=!verified&&previous?.trackId===trackId&&!previous.verified&&previous.localPreview;
    const position=verified
      ?finite(positionSeconds)&&positionSeconds>=0?positionSeconds:null
      :continuingPreview?previous.position:0;
    slots[index]={trackId,detail:detail??(previous?.trackId===trackId?previous.detail:null),position,verified:Boolean(verified),
      localPreview:continuingPreview?previous.localPreview:null,markers:savedMarkers.get(trackId)||[],
      bpm:finite(bpm)&&bpm>0?bpm:0,duration:finite(duration)&&duration>0?duration:0,
      cuePoint:previous?.trackId===trackId?previous.cuePoint??0:0,
      hotCues:previous?.trackId===trackId?previous.hotCues??Array(8).fill(null):Array(8).fill(null),
      loop:previous?.trackId===trackId?previous.loop??null:null};
    loadSavedMarkers(trackId);
    render();
  }
  // Called only with real HTML5 audio.currentTime from the local preview player.
  // Never alters a verified Rekordbox deck or a staged slot for another track.
  // Returns true only when at least one matching staged lane was updated.
  function syncLocalPreview({trackId,positionSeconds,playing=false,reset=false}={}){
    const id=String(trackId??'');
    if(!/^\d{1,20}$/.test(id)||(!reset&&(!finite(positionSeconds)||positionSeconds<0)))return false;
    let updated=false;
    for(const [index,slot] of slots.entries()){
      if(!slot||slot.verified||slot.trackId!==id)continue;
      if(deckPreviewAudio[index]?.trackId===id)continue;
      if(reset){slot.position=0;slot.localPreview=null;}
      else{
        slot.position=slot.duration>0?Math.min(positionSeconds,slot.duration):positionSeconds;
        slot.localPreview={playing:playing===true};
      }
      updated=true;
    }
    if(updated)render();
    return updated;
  }
  function syncExternalTransport(decks){
    // A Rust/CoreAudio playback clock is authoritative only when the
    // native adapter explicitly forwards its status. Do not start Web Audio.
    if(!Array.isArray(decks))return false;
    let updated=false;
    for(const state of decks){
      const index=Number(state?.deck)-1;
      if(index!==0&&index!==1)continue;
      const slot=slots[index],id=String(state?.trackId??'');
      if(!slot||slot.verified||slot.trackId!==id||!/^\d{1,20}$/.test(id))continue;
      const position=Number(state.positionSeconds);
      const playing=state.playing===true;
      if(!Number.isFinite(position)||position<0)continue;
      const duration=Number(state.durationSeconds);
      if(Number.isFinite(duration)&&duration>0)slot.duration=duration;
      const next=slot.duration>0?clamp(position,0,slot.duration):position;
      if(Math.abs((slot.position??0)-next)>.025||slot.localPreview?.source!=='rust'||
        slot.localPreview?.playing!==playing){
        slot.position=next;
        slot.localPreview={playing,source:'rust'};
        updated=true;
      }
    }
    if(updated)render();
    return updated;
  }
  function clearExternalTransport(){
    let updated=false;
    for(const slot of slots){
      if(slot?.localPreview?.source==='rust'){
        slot.localPreview={playing:false,source:'deck'};
        updated=true;
      }
    }
    if(updated)render();
    return updated;
  }
  window.addEventListener('music-hub:markers',event=>{
    const trackId=String(event.detail?.id??'');
    if(!/^\d{1,20}$/.test(trackId))return;
    const markers=Array.isArray(event.detail?.markers)?event.detail.markers.filter(m=>m?.source==='user'):[];
    savedMarkers.set(trackId,markers);
    for(const slot of slots)if(slot?.trackId===trackId)slot.markers=markers;
    render();
  });
  window.MusicHubTopDecks={init,setDeck,render,setWaveformStyle,syncLocalPreview,
    syncExternalTransport,clearExternalTransport,seekDeck,
    preloadDeck:n=>{
      const index=Number(n)-1;
      if(index!==0&&index!==1||!slots[index]||slots[index].verified)return false;
      const entry=previewEntry(index);
      if(!entry)return false;
      // Warm the Web Audio decoding/mixing graph at LOAD rather than the
      // first physical PLAY press. Only two staged decks are preallocated.
      // If WebKit cannot start the context yet, setupMixAudio keeps the
      // HTML audio fallback and the play handler can retry normally.
      setupMixAudio(entry);
      return true;
    },
    playDeck:n=>toggleDeckPreview(Number(n)-1),
    startDeck:n=>toggleDeckPreview(Number(n)-1,true),
    setCrossfade,setChannelFader,setEq,setFilter,setTempo,cueDeck,jogDeck,syncDeck,
    loopIn,loopOut,loopFourBeat,loopExit,loopHalf,loopDouble,triggerHotCue,beatJump,beatLoop,setHeadphoneCue,
    setMasterLevel,setTrim,setHeadphoneMix,setHeadphoneLevel,mixerState,fadeTo,autoTransition,
    localStatus:()=>({source:'local-preview',deckA:slots[0]?.trackId||null,deckB:slots[1]?.trackId||null,
      playingA:!!deckPreviewAudio[0]&&!deckPreviewAudio[0].audio.paused,
      playingB:!!deckPreviewAudio[1]&&!deckPreviewAudio[1].audio.paused,crossfade:localCrossfade,
      channelFaders:[...channelFaders],eq:deckEQ.map(x=>({...x})),filters:[...deckFilters],tempo:[...deckTempo],headphoneCue:[...headphoneCue],
      masterLevel,trim:[...deckTrim],headphoneMix,headphoneLevel,
      deckControls:slots.map(slot=>slot?{cuePoint:slot.cuePoint,hotCues:[...slot.hotCues],loop:slot.loop?{...slot.loop}:null,bpm:slot.bpm}:null),
      // Use the browser's actual decoded audio clock, not just last UI render.
      // WebKit may throttle timeupdate/requestAnimationFrame when backgrounded.
      positionA:finite(deckPreviewAudio[0]?.audio?.currentTime)?deckPreviewAudio[0].audio.currentTime:finite(slots[0]?.position)?slots[0].position:null,
      positionB:finite(deckPreviewAudio[1]?.audio?.currentTime)?deckPreviewAudio[1].audio.currentTime:finite(slots[1]?.position)?slots[1].position:null,
      durationA:slots[0]?.duration||0,durationB:slots[1]?.duration||0,
      errorA:!!slots[0]?.localPreview?.error,errorB:!!slots[1]?.localPreview?.error,
      audioReadyStateA:deckPreviewAudio[0]?.audio?.readyState??null,
      audioReadyStateB:deckPreviewAudio[1]?.audio?.readyState??null,
      audioNetworkStateA:deckPreviewAudio[0]?.audio?.networkState??null,
      audioNetworkStateB:deckPreviewAudio[1]?.audio?.networkState??null,
      audioErrorA:deckPreviewAudio[0]?.audio?.error?.code??null,
      audioErrorB:deckPreviewAudio[1]?.audio?.error?.code??null,
      playStateA:deckPreviewAudio[0]?.playState??null,
      playStateB:deckPreviewAudio[1]?.playState??null,
      playErrorA:deckPreviewAudio[0]?.playError??null,
      playErrorB:deckPreviewAudio[1]?.playError??null,
      playMetricsA:recentPlayMetrics[0]?{...recentPlayMetrics[0]}:null,
      playMetricsB:recentPlayMetrics[1]?{...recentPlayMetrics[1]}:null,
      audioContextState:mixContext?.state??null,
      verifiedA:!!slots[0]?.verified,verifiedB:!!slots[1]?.verified,
      autoFading:fadePending||fadeTimer!==null})};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});
  else init();
})();
