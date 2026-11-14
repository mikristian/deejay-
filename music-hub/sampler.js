/* Vintage Sampler Lab: 16 local pads, standalone from Rekordbox's deck transport. */
(()=>{
  'use strict';
  const $=id=>document.getElementById(id);
  const api=async(path,body)=>{
    const res=await fetch(path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});
    const json=await res.json();
    if(!res.ok||json.error)throw Error(json.error||'Sampler request failed');
    return json;
  };
  const keys=['1','2','3','4','q','w','e','r','a','s','d','f','z','x','c','v'];
  let state={mode:'deck',engine:'vsl',bank:1,pads:Array(16).fill(null)};
  let library=new Map(),sounds=new Map(),pending=false,kitEnabled=false,kitAvailable=false,lastSequence=0;
  const safe=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const feedback=(message,error=false)=>{const el=$('sampler-feedback');el.textContent=message;el.style.color=error?'#f1a49e':'';};
  function showBridgeStatus(bridge){
    const el=$('sampler-bridge-status');if(!el)return;
    if(!bridge?.ok){el.textContent='FLX4 bridge offline · use Launch FLX4 Vintage Sampler.command';return;}
    const p=bridge.physical||{},a=p.direct_audio||{};
    const left=Number(p.left_deck_presses||0),right=Number(p.right_deck_presses||0);
    const audio=a.ready?'DDJ-FLX4 MASTER AUDIO READY':('Direct audio unavailable'+(a.last_error?' · '+a.last_error:''));
    const last=p.last_pad?' · Last physical chop '+p.last_pad+' ('+(p.last_pad_mode||'pad')+')':'';
    const active=Number(a.active_voices||0);
    el.textContent=audio+' · LEFT '+left+' / RIGHT '+right+' received · '+active+' playing'+last;
  }
  function render(){
    $('sampler-launch').setAttribute('aria-pressed',String(!$('sampler-lab').hidden));
    $('sampler-mode').value=state.mode;
    $('sampler-engine').value=state.engine||'vsl';
    $('sampler-kit').disabled=!kitAvailable;
    $('sampler-kit').textContent=kitEnabled?'16-slice kit loaded · use library pads':'Load 16-slice kit';
    $('sampler-active').textContent=state.mode==='sampler'?'FLX4 LEFT 8 + RIGHT 8 → 16 chops · '+(state.engine==='direct'?'Direct DDJ-FLX4 MASTER stereo audio':state.engine==='browser'?'Music Hub browser audio':'Vintage Sampler Lab MIDI'):'FLX4 sampler routing OFF · DJ deck controls preserved';
    $('sampler-grid').innerHTML=state.pads.map((id,i)=>{
      const t=library.get(id);const label=t?(t.title||t.name||id):id||'Empty · assign a song';
      const shown=kitEnabled?'Slice '+String(i+1).padStart(2,'0'):label;
      return '<button type="button" class="sampler-pad" data-sampler-pad="'+(i+1)+'" aria-label="Play pad '+(i+1)+'"><b>'+String(i+1).padStart(2,'0')+'</b><span>'+safe(shown)+'</span><small>'+keys[i].toUpperCase()+(kitEnabled?' · WAV sample':id?' · Local preview':' · Unassigned')+'</small></button>';
    }).join('');
  }
  async function setMode(mode){
    if(!['deck','sampler'].includes(mode))return;
    try{state=await api('/api/music-hub/sampler/action',{action:'mode',mode});render();feedback(mode==='sampler'?'FLX4 PAD FX 1 and PAD FX 2 pads now map to your 16 chops. Left deck = 1–8, right deck = 9–16.':'Sampler mapping off; DJ deck controls preserved.');window.dispatchEvent(new CustomEvent('music-hub:sampler-mode',{detail:{mode}}));}
    catch(e){render();feedback(e.message,true);}
  }
  async function trigger(pad){
    if(!Number.isInteger(pad)||pad<1||pad>16||state.mode!=='sampler')return false;
    const id=state.pads[pad-1];if(!kitEnabled&&!id){feedback('Pad '+pad+' is empty. Assign a local song first.',true);return false;}
    if(state.engine==='direct'){
      try{
        await api('/api/music-hub/sampler/direct-trigger',{action:'trigger',pad});
        const button=document.querySelector('[data-sampler-pad="'+pad+'"]');
        if(button){button.dataset.playing='true';setTimeout(()=>{button.dataset.playing='false';},950);}
        feedback('Chop '+pad+' triggered on DDJ-FLX4 MASTER L/R · direct 16-pad audio engine');
        return true;
      }catch(e){feedback('Direct FLX4 audio: '+e.message,true);return false;}
    }
    // Same-origin audio endpoint validates local file path and supports range requests.
    try{
      const previous=sounds.get(pad);if(previous){previous.pause();previous.removeAttribute('src');previous.load();}
      const audio=new Audio(kitEnabled?'/api/music-hub/sampler/audio?pad='+pad:'/api/music-hub/audio?id='+encodeURIComponent(id));
      audio.preload='auto';audio.volume=Number($('sampler-volume').value)/100;
      sounds.set(pad,audio);
      const button=document.querySelector('[data-sampler-pad="'+pad+'"]');
      if(button)button.dataset.playing='true';
      const done=()=>{if(button)button.dataset.playing='false';if(sounds.get(pad)===audio)sounds.delete(pad);};
      audio.addEventListener('ended',done,{once:true});audio.addEventListener('error',()=>{done();feedback('Audio unavailable for pad '+pad+'. Check local source file.',true);},{once:true});
      await audio.play();
      feedback('Playing pad '+pad+' · '+(kitEnabled?'sample slice':library.get(id)?.title||id)+' · browser audio output');
      window.dispatchEvent(new CustomEvent('music-hub:sampler-pad',{detail:{pad,bank:1,mode:'sampler',trackId:id}}));
      return true;
    }catch(e){feedback('Could not play pad '+pad+': '+e.message,true);return false;}
  }
  function stopAll(){
    for(const audio of sounds.values()){audio.pause();audio.removeAttribute('src');audio.load();}
    sounds.clear();
    document.querySelectorAll('[data-sampler-pad]').forEach(b=>b.dataset.playing='false');
    if(state.engine==='direct')api('/api/music-hub/sampler/direct-trigger',{action:'stop',pad:1}).catch(e=>feedback('Cannot stop FLX4 audio: '+e.message,true));
    feedback('All sampler pads stopped');
  }
  async function assign(clear=false){
    if(pending)return;
    pending=true;
    const pad=Number($('sampler-assign-pad').value);
    let id=$('sampler-track').value.trim();
    if(!clear&&!/^\d+$/.test(id)){feedback('Enter the Rekordbox track ID of a local song.',true);pending=false;return;}
    try{state=await api('/api/music-hub/sampler/action',clear?{action:'clear',pad}:{action:'assign',pad,trackId:id});render();feedback(clear?'Pad '+pad+' cleared':'Local track '+id+' assigned to pad '+pad);}
    catch(e){feedback(e.message,true);}finally{pending=false;}
  }
  async function loadLibrary(){
    try{
      const data=await api('/api/library');
      library=new Map((data.collection||[]).map(t=>[String(t.id),t]));
      const list=$('sampler-track-suggestions');
      list.replaceChildren(...(data.collection||[]).slice(0,1500).map(t=>{const o=document.createElement('option');o.value=String(t.id);o.label=[t.title,t.artist].filter(Boolean).join(' · ');return o;}));
      render();
    }catch{feedback('Library titles unavailable; use a valid Rekordbox track ID.');}
  }
  document.addEventListener('DOMContentLoaded',async()=>{
    const launch=$('sampler-launch'),lab=$('sampler-lab');if(!launch||!lab)return;
    launch.addEventListener('click',()=>{lab.hidden=!lab.hidden;render();});
    $('sampler-mode').addEventListener('change',e=>setMode(e.target.value));
    $('sampler-engine').addEventListener('change',async e=>{try{state=await api('/api/music-hub/sampler/action',{action:'engine',engine:e.target.value});render();feedback('Physical pads routed to '+(state.engine==='direct'?'DDJ-FLX4 MASTER audio (both decks at once)':state.engine==='vsl'?'Vintage Sampler Lab MIDI':'Music Hub browser'));}catch(error){render();feedback(error.message,true);}});
    $('sampler-kit').addEventListener('click',()=>{kitEnabled=!kitEnabled;render();feedback(kitEnabled?'16 WAV slices loaded from Vintage Sampler Lab kit.':'Showing local Rekordbox song pads.');});
    $('sampler-grid').addEventListener('click',e=>{const b=e.target.closest('[data-sampler-pad]');if(b)trigger(Number(b.dataset.samplerPad));});
    $('sampler-assign-button').addEventListener('click',()=>assign());
    $('sampler-clear-button').addEventListener('click',()=>assign(true));
    $('sampler-stop').addEventListener('click',stopAll);
    $('sampler-volume').addEventListener('input',e=>{for(const sound of sounds.values())sound.volume=Number(e.target.value)/100;});
    document.addEventListener('keydown',e=>{if(lab.hidden||state.mode!=='sampler'||e.repeat||e.metaKey||e.ctrlKey||e.altKey||/input|textarea|select/i.test(e.target?.tagName||''))return;const pad=keys.indexOf(e.key.toLowerCase())+1;if(pad){e.preventDefault();trigger(pad);}});
    // Bridge can dispatch this event after a physical FLX4 pad button press.
    window.addEventListener('music-hub:physical-pad',e=>{if(e.detail?.pressed!==false)trigger(Number(e.detail?.pad));});
    window.MusicHubSampler={trigger,setMode,stopAll,status:()=>({...state}),keys};
    try{const data=await api('/api/music-hub/sampler/status');state=data;kitAvailable=data.kit?.available===true;kitEnabled=kitAvailable;if(state.mode==='sampler')lab.hidden=false;showBridgeStatus(data.bridge);if(kitEnabled)feedback('16-slice kit ready · both FLX4 decks can play at once.');}catch(e){feedback('Sampler backend unavailable: '+e.message,true);}
    render();loadLibrary();
    setInterval(async()=>{
      if(lab.hidden)return;
      try{
        const data=await api('/api/music-hub/sampler/status');
        showBridgeStatus(data.bridge);
        if(data.mode!==state.mode||data.engine!==state.engine){state={...state,mode:data.mode,engine:data.engine};render();}
      }catch{showBridgeStatus({ok:false});}
    },1100);
    // Poll native bridge events. Start at current sequence so stale presses cannot replay.
    try{const first=await api('/api/music-hub/sampler/events?after=0');lastSequence=first.latest||0;}catch{}
    setInterval(async()=>{
      if(state.mode!=='sampler'||state.engine!=='browser'||document.hidden)return;
      try{
        const result=await api('/api/music-hub/sampler/events?after='+lastSequence);
        lastSequence=result.latest||lastSequence;
        for(const event of result.events||[])if(event.pressed)trigger(Number(event.pad));
      }catch{}
    },180);
  });
})();
