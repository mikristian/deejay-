/* Explicit, token-paired laptop consumer of mobile LOCAL PREVIEW commands.
 * The separate LAN server queues intents. Only this open Music Hub browser
 * can execute them against local HTML5 audio. Never sends Rekordbox MIDI.
 */
(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const TOKEN_KEY='music-hub-desktop-remote-session-token-v1';
  const URL_KEY='music-hub-desktop-remote-session-url-v1';
  let base='',token='',active=false,timer=null,pending=false,lastHeartbeat=0,consecutiveFailures=0,lastPairCheck=0,latestPair=null,dismissedPair=null;
  const terminal=()=>window.MusicHubTopDecks;
  const auto=()=>window.MusicHubLocalAutomix;
  function validUrl(value){
    let u;
    try{u=new URL(String(value).trim());}catch{return null;}
    if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)return null;
    const p=u.hostname.split('.').map(Number);
    if(p.length!==4||p.some(n=>!Number.isInteger(n)||n<0||n>255))return null;
    const local=p[0]===127||p[0]===10||(p[0]===192&&p[1]===168)||(p[0]===172&&p[1]>=16&&p[1]<=31);
    if(!local||!u.port||Number(u.port)<1024||Number(u.port)>65535)return null;
    if(u.pathname!=='/')return null;
    return u.origin;
  }
  function feedback(value){
    const status=$('desktop-remote-status');
    if(status)status.textContent=value;
    const trigger=$('desktop-remote-pair');
    if(trigger){trigger.textContent=active?'PHONE CONNECTED':'PAIR PHONE';trigger.setAttribute('aria-pressed',String(active));}
  }
  function showPairApproval(entry){
    latestPair=entry||null;
    let banner=$('music-phone-approval');
    if(!banner&&!entry)return;
    if(!banner){
      banner=document.createElement('aside');
      banner.id='music-phone-approval';banner.className='music-phone-approval';banner.hidden=true;
      banner.setAttribute('role','region');
      banner.setAttribute('aria-label','Approve phone connection');
      banner.innerHTML='<strong>Connect your iPhone?</strong><span id="music-phone-device"></span><span>Confirm this number matches your phone:</span><b id="music-phone-code"></b><div><button id="music-phone-approve" type="button">Approve Phone</button><button id="music-phone-dismiss" type="button">Not now</button></div><small>Controls Music Hub local audio, not rekordbox hardware transport.</small>';
      document.body.append(banner);
      $('music-phone-approve').addEventListener('click',async()=>{
        const current=latestPair;
        if(!current||!active)return;
        $('music-phone-approve').disabled=true;
        try{
          const result=await request('/api/remote/v1/pair/approve','POST',
            {requestId:current.requestId,code:current.code});
          if(result.approved){showPairApproval(null);feedback('iPhone approved. Complete pairing on your phone.');}
        }catch(error){feedback('Phone approval failed: '+String(error.message).slice(0,85));}
        finally{$('music-phone-approve').disabled=false;}
      });
      $('music-phone-dismiss').addEventListener('click',()=>{
        if(latestPair)dismissedPair=latestPair.requestId;
        showPairApproval(null);
      });
    }
    banner.hidden=!entry;
    if(entry){
      $('music-phone-device').textContent=entry.label+' wants to connect';
      $('music-phone-code').textContent=entry.code;
    }
  }
  async function request(path,method='GET',data){
    const headers={Authorization:'Bearer '+token};
    if(data!==undefined)headers['Content-Type']='application/json';
    const response=await fetch(base+path,{method,mode:'cors',credentials:'omit',redirect:'error',
      cache:'no-store',headers,...(data!==undefined?{body:JSON.stringify(data)}:{})});
    const result=await response.json();
    if(!response.ok||result.error)throw Error(result.error||'Remote bridge HTTP '+response.status);
    return result;
  }
  function execute(command){
    const action=command?.action,args=command?.args||{},mix=terminal();
    if(!mix)return false;
    if(action==='local.stage'){
      if(!['1','2'].includes(args.deck)||typeof args.trackId!=='string'||!/^\d{1,20}$/.test(args.trackId))return false;
      return window.MusicHubDesktopController?.stage?.(Number(args.deck),args.trackId)===true;
    }
    if(action==='local.play'){
      if(!['1','2'].includes(args.deck))return false;
      return mix.playDeck(Number(args.deck));
    }
    if(action==='local.seek'){
      if(!['1','2'].includes(args.deck)||typeof args.positionSec!=='number'||!Number.isFinite(args.positionSec)||args.positionSec<0)return false;
      const status=mix.localStatus(),duration=Number(args.deck)==1?status.durationA:status.durationB;
      return duration>0&&mix.seekDeck(Number(args.deck)-1,Math.max(0,Math.min(1,args.positionSec/duration)));
    }
    if(action==='local.fade'){
      return typeof args.target==='number'&&typeof args.durationMs==='number'&&
        mix.fadeTo(args.target,args.durationMs/1000);
    }
    if(action==='local.autoMixStart'){
      auto()?.start();
      return auto()?.status()?.running===true;
    }
    if(action==='local.autoMixStop'){auto()?.stop();return true;}
    return false;
  }
  function previewSnapshot(){
    const state=terminal()?.localStatus?.()||{};
    const id=name=>{
      const suffix=name==='deckA'?'A':'B';
      if(state['verified'+suffix])return null;
      return /^\d{1,20}$/.test(String(state[name]||''))?String(state[name]):null;
    };
    const number=name=>Number.isFinite(state[name])&&state[name]>=0&&state[name]<=86400?state[name]:0;
    return {deckA:id('deckA'),deckB:id('deckB'),
      playingA:state.playingA===true,playingB:state.playingB===true,
      positionA:number('positionA'),positionB:number('positionB'),
      durationA:number('durationA'),durationB:number('durationB'),
      crossfade:Number.isFinite(state.crossfade)?Math.max(0,Math.min(1,state.crossfade)):.5,
      autoFading:state.autoFading===true};
  }
  async function tick(){
    if(!active||pending)return;
    pending=true;
    try{
      // Native Rust decks update their audio clocks off the WebKit UI thread.
      // Refresh the paired phone every tick while Rust is active, rather than
      // leaving its PLAY state and position up to ~4.8 seconds behind.
      const rustPlaying=window.MusicHubRustAudio?.status?.().engine==='rust';
      if(Date.now()-lastHeartbeat>(rustPlaying?850:3500)){
        await request('/api/remote/v1/heartbeat','POST',{preview:previewSnapshot()});
        lastHeartbeat=Date.now();
      }
      const payload=await request('/api/remote/v1/commands');
      const commands=Array.isArray(payload?.commands)?payload.commands.slice(0,64):[];
      for(const command of commands){
        if(!/^[a-f0-9]{32}$/i.test(String(command?.id||'')))continue;
        let succeeded=false;
        try{succeeded=execute(command)===true;}catch{}
        // The service removes commands on delivery. Ack acknowledges receipt,
        // without asserting the browser's audio engine accepted playback.
        await request('/api/remote/v1/ack','POST',{id:command.id});
        if(!succeeded)feedback('Command received; local audio not ready or blocked.');
      }
      if(Date.now()-lastPairCheck>2500){
        lastPairCheck=Date.now();
        try{
          const response=await request('/api/remote/v1/pair/pending');
          const awaiting=Array.isArray(response.requests)?response.requests:[];
          const newest=awaiting[0]||null;
          if(newest&&newest.requestId!==dismissedPair&&latestPair?.requestId!==newest.requestId)showPairApproval(newest);
          if(!newest&&latestPair)showPairApproval(null);
        }catch{} // Pairing UI failure must never interrupt active playback.
      }
      consecutiveFailures=0;
      if(!commands.length)feedback('Paired · phone can control local audio on this laptop');
    }catch(error){
      feedback('Phone bridge connection lost · '+String(error.message).slice(0,95));
      consecutiveFailures++;
      if(consecutiveFailures>=3){
        stop(false);
        feedback('Phone bridge disconnected · reconnect to restore remote controls.');
      }
    }finally{pending=false;}
  }
  async function connect(url,secret){
    const origin=validUrl(url);
    if(!origin||typeof secret!=='string'||secret.length<32){
      feedback('Use a private IPv4 bridge URL and a pairing token of 32+ characters.');
      return false;
    }
    stop(true);
    base=origin;token=secret;
    try{
      await request('/api/remote/v1/heartbeat','POST',{preview:previewSnapshot()});
      lastHeartbeat=Date.now();consecutiveFailures=0;active=true;
      sessionStorage.setItem(URL_KEY,origin);
      sessionStorage.setItem(TOKEN_KEY,secret);
      timer=setInterval(tick,1200);
      feedback('Paired · local playback remote enabled');
      await tick();
      return true;
    }catch(error){
      active=false;
      feedback('Unable to pair: '+String(error.message).slice(0,95));
      return false;
    }
  }
  function stop(forget=true){
    active=false;
    if(timer!==null){clearInterval(timer);timer=null;}
    if(forget){
      try{sessionStorage.removeItem(URL_KEY);sessionStorage.removeItem(TOKEN_KEY);}catch{}
      base='';token='';
    }
    feedback('Phone connection off');
    showPairApproval(null);
  }
  function init(){
    const top=document.querySelector('#performance-panel .performance-top');
    if(!top||$('desktop-remote-pair'))return;
    const trigger=document.createElement('button');
    trigger.type='button';trigger.id='desktop-remote-pair';trigger.className='desktop-remote-pair';
    trigger.textContent='PAIR PHONE';trigger.setAttribute('aria-pressed','false');
    trigger.setAttribute('aria-expanded','false');
    const panel=document.createElement('div');
    panel.id='desktop-remote-settings';panel.className='desktop-remote-settings';panel.hidden=true;
    panel.innerHTML='<label>Bridge address<input id="desktop-remote-url" type="url" inputmode="url" value="http://127.0.0.1:18770" autocomplete="off"></label><label>Pairing token<input id="desktop-remote-token" type="password" minlength="32" autocomplete="off" spellcheck="false"></label><button id="desktop-remote-connect" type="button">Connect</button><button id="desktop-remote-disconnect" type="button">Disconnect</button><span id="desktop-remote-status" role="status">Phone connection off</span><small>Local audio preview only. The remote service must be started separately on your trusted network.</small>';
    top.append(trigger,panel);
    trigger.addEventListener('click',()=>{
      panel.hidden=!panel.hidden;
      trigger.setAttribute('aria-expanded',String(!panel.hidden));
    });
    $('desktop-remote-connect').addEventListener('click',()=>connect($('desktop-remote-url').value,$('desktop-remote-token').value));
    $('desktop-remote-disconnect').addEventListener('click',()=>stop());
    let saved='',savedUrl='';
    try{saved=sessionStorage.getItem(TOKEN_KEY)||'';savedUrl=sessionStorage.getItem(URL_KEY)||'';}catch{}
    if(savedUrl)$('desktop-remote-url').value=savedUrl;
    if(saved.length>=32&&savedUrl)connect(savedUrl,saved);
    else {
      // Explicit private DJ workflow: the native laptop Music Hub can join
      // its already-installed local bearer bridge without requiring users to
      // copy a secret between the two Macs. No secret is in static JS/HTML.
      fetch('/api/music-hub/local-remote/bootstrap',{
        method:'GET',cache:'no-store',credentials:'same-origin',redirect:'error'
      }).then(async response=>{
        if(!response.ok)throw Error('Unavailable');
        return response.json();
      }).then(config=>{
        if(typeof config.token==='string'&&config.token.length>=32){
          $('desktop-remote-url').value=config.bridge;
          $('desktop-remote-token').value=config.token;
          connect(config.bridge,config.token);
        }
      }).catch(()=>feedback('Phone pairing is available from the laptop settings.'));
    }
  }
  window.MusicHubDesktopRemote={init,connect,stop,status:()=>({active,base:base||null})};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});
  else init();
})();
