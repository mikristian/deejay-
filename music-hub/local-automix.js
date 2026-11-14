/* Continuous local audio crossfades following the user's Music Hub Next Up order.
 * Two actual HTML5 audio sources are mixed by MusicHubTopDecks; Rekordbox MIDI,
 * playback and hardware position are never controlled by this module.
 */
(() => {
  'use strict';
  let running=false,source=1,next=2,phase='idle',tickTimer=null,startedAt=0;
  let list=[],feedback;
  const $=id=>document.getElementById(id);
  const deck=()=>window.MusicHubTopDecks;
  const desktop=()=>window.MusicHubDesktopController;
  const clock=seconds=>{
    if(!Number.isFinite(seconds)||seconds<0)return '—:—';
    const t=Math.floor(seconds);
    return Math.floor(t/60)+':'+String(t%60).padStart(2,'0');
  };
  function message(value){
    if(feedback)feedback.textContent=value;
    if($('local-automix-toggle'))$('local-automix-toggle').title=value;
  }
  function stop(reason='Automatic transitions stopped. Playback remains under your control.'){
    if(tickTimer!==null){clearInterval(tickTimer);tickTimer=null;}
    running=false;phase='idle';
    const button=$('local-automix-toggle');
    if(button){button.textContent='AUTO MIX SET';button.setAttribute('aria-pressed','false');}
    message(reason);
  }
  function other(n){return n===1?2:1;}
  function stateFor(n,status){
    const letter=n===1?'A':'B';
    return {track:status['deck'+letter],position:status['position'+letter],
      duration:status['duration'+letter],playing:status['playing'+letter],
      verified:status['verified'+letter],error:status['error'+letter]};
  }
  function nextTrack(){
    if(next>=list.length)return false;
    const target=other(source),id=list[next];
    if(!desktop()?.stage(target,id))return false;
    next++;
    return true;
  }
  function tick(){
    if(!running)return;
    const mix=deck()?.localStatus?.();if(!mix)return stop('Local audio engine unavailable.');
    const active=stateFor(source,mix),incoming=stateFor(other(source),mix);
    if(active.verified||incoming.verified)return stop('Verified Rekordbox deck detected. Local automix stopped.');
    if(active.error||incoming.error)return stop('Local audio could not be decoded. Choose another track.');
    if(phase==='transition'){
      if(mix.autoFading){message('Crossfading to Deck '+(source===1?'B':'A')+'…');return;}
      if(incoming.playing&&!active.playing){
        source=other(source);phase='playing';
        const played=list.length-next;
        if(played>0&&!nextTrack())return stop('Could not stage next local track.');
        if(played===0)desktop()?.clear(other(source));
        startedAt=Date.now();
        message('Now playing Deck '+(source===1?'A':'B')+'. '+Math.max(0,list.length-next)+' tracks remain to stage.');
      }else if(Date.now()-startedAt>20000){
        return stop('Local transition did not complete. Playback remains manual.');
      }
      return;
    }
    const remaining=Math.max(0,active.duration-(active.position||0));
    if(next>=list.length&&!incoming.track){
      if(remaining<.3)return stop('Local set finished.');
      message('Last local track · '+clock(remaining)+' remaining');
      if(!active.playing&&Date.now()-startedAt>20000)return stop('Local playback paused or unavailable.');
      return;
    }
    if(!active.playing){
      if(Date.now()-startedAt>20000)return stop('Local playback did not start.');
      return;
    }
    if(!incoming.track){
      message('Waiting for next local track');
      return;
    }
    const fadeSeconds=Math.min(8,Math.max(2,active.duration*.16));
    const lead=fadeSeconds+Math.min(3,active.duration*.07);
    message('Deck '+(source===1?'A':'B')+' · '+clock(remaining)+' until end');
    if(remaining<=lead){
      if(!deck().autoTransition(fadeSeconds))return stop('Auto transition could not start.');
      phase='transition';startedAt=Date.now();
      message('Starting local crossfade…');
    }
  }
  function start(){
    const controller=desktop(),audio=deck();
    if(!controller||!audio)return message('Music Hub is still starting.');
    list=controller.queue().filter(id=>controller.track(id)).map(String);
    if(list.length<2)return message('Add at least two local songs to Next Up first.');
    const live=controller.verified();
    if(live.a||live.b)return message('A verified Rekordbox deck is active. Local Auto Mix is unavailable.');
    if(!controller.stage(1,list[0])||!controller.stage(2,list[1]))return message('Could not stage both local decks.');
    source=1;next=2;phase='playing';startedAt=Date.now();running=true;
    audio.setCrossfade(0);
    // Start within this explicit button click to preserve browser audio
    // activation on Safari/macOS; a later timer only schedules real fades.
    if(!audio.startDeck(1)){stop('Could not start Deck A local audio.');return;}
    const button=$('local-automix-toggle');
    if(button){button.textContent='STOP AUTO MIX';button.setAttribute('aria-pressed','true');}
    message('Playing queued set locally · '+list.length+' songs · automatic crossfades');
    tickTimer=setInterval(tick,250);
  }
  function init(){
    const top=document.querySelector('#performance-panel .performance-top');
    if(!top||$('local-automix-toggle'))return;
    const button=document.createElement('button');
    button.id='local-automix-toggle';button.type='button';button.className='local-automix-toggle';
    button.textContent='AUTO MIX SET';button.setAttribute('aria-pressed','false');
    button.title='Locally mix queued audio from Music Hub. Rekordbox hardware control is unavailable.';
    button.addEventListener('click',()=>running?stop():start());
    feedback=document.createElement('span');feedback.id='local-automix-status';
    feedback.className='local-automix-status';feedback.setAttribute('role','status');
    feedback.textContent='Local audio · 2+ queued tracks';
    top.append(button,feedback);
  }
  window.MusicHubLocalAutomix={init,start,stop,status:()=>({running,phase,source,next,queue:list.slice()})};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});
  else init();
})();
