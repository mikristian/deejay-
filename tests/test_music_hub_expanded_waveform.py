"""Canvas behavior regression for analyzed expanded deck waveforms."""
from pathlib import Path
import subprocess
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / 'music-hub' / 'top-decks-waveform.js'


class ExpandedWaveformTests(unittest.TestCase):
    def test_script_parses(self):
        subprocess.run(['node', '--check', str(SCRIPT)], check=True, capture_output=True, text=True)

    def test_real_colors_beats_staging_and_collapse(self):
        # Run the real browser module against a minimal recording canvas.
        code = r'''
const assert=require('node:assert/strict'), fs=require('node:fs'),vm=require('node:vm');
const fills=[],texts=[],strokes=[];
const ctx={
  fillRect(...args){fills.push([this.fillStyle,...args]);},
  fillText(t){texts.push(t);},
  stroke(){strokes.push(this.strokeStyle);},
  setTransform(){},beginPath(){},moveTo(){},lineTo(){},closePath(){},rect(){},clip(){},save(){},restore(){},fill(){}
};
function el(id){return {id,style:{},attrs:{},handlers:{},children:[],classList:{toggle(){},contains(){return false}},clientWidth:640,clientHeight:88,
  innerHTML:'',firstElementChild:null,append(...children){this.children.push(...children);for(const child of children)if(child.id)nodes[child.id]=child},before(){},addEventListener(name,fn){this.handlers[name]=fn},setAttribute(k,v){this.attrs[k]=v},
  getBoundingClientRect(){return {left:0,top:0,width:640,height:88}},getContext(){return ctx},closest(){return {classList:{contains(){return false}}}}};}
const panel=el('performance-panel'),nodes={'performance-panel':panel};
const deckWaveA=el('deck-one-wave'),deckWaveB=el('deck-two-wave');
for(const wave of [deckWaveA,deckWaveB])wave.closest=()=>({getBoundingClientRect(){return {left:0,top:0,width:640,height:200}}});
for(const [label,wave] of [['A',deckWaveA],['B',deckWaveB]])wave.after=row=>{row.container=label;nodes[row.id]=row;};
nodes['deck-one-wave']=deckWaveA;nodes['deck-two-wave']=deckWaveB;
panel.querySelector=()=>({before(){},append(){}});
const audios=[];
function audioElement(){
  const audio=el('local-audio');
  audio.paused=true;audio.ended=false;audio.currentTime=0;audio.readyState=0;audio.duration=10;
  audio.listeners={};
  audio.addEventListener=(name,fn)=>{(audio.listeners[name]??=[]).push(fn)};
  audio.emit=name=>{for(const listener of (audio.listeners[name]||[]))listener()};
  audio.pause=()=>{audio.paused=true;audio.emit('pause')};
  audio.play=()=>{audio.paused=false;audio.emit('play');return Promise.resolve()};
  audio.load=()=>{audio.readyState=0};
  audio.removeAttribute=name=>{if(name==='src')audio.src=''};
  audios.push(audio);return audio;
}
const document={readyState:'loading',activeElement:{},addEventListener(){},createElement(tag){if(tag==='audio')return audioElement();if(tag==='style'){nodes['injected-wave-style']=el('injected-wave-style');return nodes['injected-wave-style']}return el('created')},getElementById(id){return nodes[id]||null}};
const window={devicePixelRatio:2,addEventListener(){}};
const saved={};const localStorage={getItem(k){return saved[k]??null},setItem(k,v){saved[k]=v}};
vm.runInNewContext(fs.readFileSync(process.argv[1],'utf8'),{window,document,localStorage,fetch(){return Promise.reject(Error('offline'))},ResizeObserver:undefined,MutationObserver:undefined});
// The inserted HTML exists in the browser; mimic its canvas and controls at init.
let initialized=false;
const toolbar=el('performance-top');
panel.querySelector=selector=>selector==='.performance-top'?toolbar:{before(){
  nodes['top-decks-wave-canvas']=el('top-decks-wave-canvas');
  nodes['top-decks-wave-expand']=el('top-decks-wave-expand');
  nodes['top-decks-wave-strip']=el('top-decks-wave-strip');
  nodes['top-decks-wave-strip'].closest=()=>({classList:{contains(){return false}}});
  initialized=true;
}};
window.MusicHubTopDecks.init();assert(initialized);
assert.equal(nodes['top-decks-wave-style'].className,'top-decks-wave-style','toolbar append registers the style control');
assert.equal(nodes['top-decks-wave-style'].textContent,'3-BAND COLOR');
assert.equal(nodes['top-decks-wave-style'].attrs['aria-pressed'],'false');
const detail={waveform:{heights:[.4,.8,.7,.9],colors:[[10,20,30],[40,50,60],[70,80,90],[100,110,120]]},
  analysis:{beats:[{time:0,beat:1,bpm:120},{time:.5,beat:2,bpm:120},{time:1,beat:3,bpm:120},{time:1.5,beat:4,bpm:120},{time:2,beat:1,bpm:120}]},cues:{cues:[]}};
window.MusicHubTopDecks.setDeck(1,{track:{id:'1',length:3,bpm:120},detail});
assert(fills.some(x=>x[0]==='#266bff'),'default draws royal blue outer amplitude');
assert(fills.some(x=>x[0]==='#ffa83d'),'default draws orange inner amplitude');
assert(fills.some(x=>x[0]==='#fff3dc'),'default draws ivory center amplitude');
assert(!fills.some(x=>String(x[0]).startsWith('rgb(')),'default is palette, not recorded RGB');
fills.length=0;
nodes['top-decks-wave-style'].handlers.click();
assert.equal(saved['music-hub-expanded-waveform-style-v1'],'rgb','toggle persists color mode');
assert.equal(nodes['top-decks-wave-style'].textContent,'ANALYSIS RGB');
assert.equal(nodes['top-decks-wave-style'].attrs['aria-pressed'],'true');
assert(fills.some(x=>String(x[0]).startsWith('rgb(')),'analysis mode draws recorded RGB');
assert(!fills.some(x=>x[0]==='#fff3dc'),'RGB mode does not invent palette center');
window.MusicHubTopDecks.setWaveformStyle('palette');
assert.equal(saved['music-hub-expanded-waveform-style-v1'],'palette');
assert(texts.includes('1.1Bars'),'first bar label must derive from analyzed beat 1');
assert(texts.includes('STAGED PREVIEW · 0:00'),'staged track must identify fixed preview position');
assert(strokes.includes('#394352'),'measured beat grid must be drawn');
fills.length=0;texts.length=0;
assert.equal(window.MusicHubTopDecks.syncLocalPreview({trackId:'999',positionSeconds:2.1,playing:true}),false,'mismatched local audio cannot move lane');
assert(texts.length===0,'mismatched ID does not even redraw');
assert.equal(window.MusicHubTopDecks.syncLocalPreview({trackId:'1',positionSeconds:2.1,playing:true}),true);
assert(texts.includes('LOCAL PREVIEW · 0:02'),'genuine local playback is labeled');
assert(texts.includes('2.1Bars'),'scrolling preview updates measured beat label');
assert(!texts.includes('STAGED PREVIEW · 0:00'));
assert(fills.some(x=>x[0]==='#266bff'&&x[1]<330),'waveform shifts left of fixed center playhead');
fills.length=0;texts.length=0;
assert.equal(window.MusicHubTopDecks.syncLocalPreview({trackId:'1',positionSeconds:2.8,playing:false}),true);
assert(texts.includes('LOCAL PREVIEW · 0:02 · PAUSED'),'paused label uses real position');
fills.length=0;texts.length=0;
window.MusicHubTopDecks.setDeck(1,{track:{id:'1',length:3,bpm:120},detail});
assert(texts.includes('LOCAL PREVIEW · 0:02 · PAUSED'),'same-track staged rerender retains preview position');
fills.length=0;texts.length=0;
assert.equal(window.MusicHubTopDecks.syncLocalPreview({trackId:'1',reset:true}),true);
assert(texts.includes('STAGED PREVIEW · 0:00'),'reset restores staged position');
assert(texts.includes('1.1Bars'),'reset restores first measured bar');
assert.equal(window.MusicHubTopDecks.syncLocalPreview({trackId:'1',positionSeconds:-1,playing:true}),false,'negative time rejected');
assert.equal(window.MusicHubTopDecks.syncLocalPreview({trackId:'1',positionSeconds:Infinity,playing:true}),false,'nonfinite time rejected');
fills.length=0;texts.length=0;
window.MusicHubTopDecks.setDeck(1,{track:{id:'1',length:3,bpm:120},detail,verified:true,positionSeconds:2.1});
assert(texts.includes('2.1Bars'),'verified position uses measured downbeat');
assert(!texts.some(x=>String(x).includes('STAGED')),'verified deck must not say staged');
fills.length=0;texts.length=0;
assert.equal(window.MusicHubTopDecks.syncLocalPreview({trackId:'1',positionSeconds:.4,playing:true}),false,'verified slot protected');
assert.equal(window.MusicHubTopDecks.syncLocalPreview({trackId:'1',reset:true}),false,'verified slot protected from reset');
assert(texts.length===0,'verified slot stays untouched and no redraw occurs');
window.MusicHubTopDecks.render();
assert(texts.includes('2.1Bars'),'verified beat position remains unchanged');
fills.length=0;texts.length=0;
window.MusicHubTopDecks.setDeck(1,{track:{id:'1',length:3,bpm:120},detail,verified:true});
assert(texts.includes('POSITION UNKNOWN'),'do not invent position for verified track');
window.MusicHubTopDecks.setWaveformStyle('rgb');
assert.equal(nodes['top-decks-wave-canvas'].width,1280,'DPR canvas width');
// Independent white scrub cursors on A and B seek only the corresponding
// local audio source; the reported Rekordbox deck remains read-only.
const aSeek=nodes['top-decks-seek-1'],bSeek=nodes['top-decks-seek-2'];
assert(aSeek&&bSeek,'both decks have native keyboard-accessible seek controls');
assert.equal(aSeek.disabled,true,'verified deck scrubber is disabled');
assert.equal(nodes['top-decks-preview-play-1'].disabled,true);
window.MusicHubTopDecks.setDeck(1,{track:{id:'1',length:3,bpm:120},detail});
window.MusicHubTopDecks.setDeck(2,{track:{id:'2',length:10,bpm:120},detail});
assert.equal(aSeek.disabled,false);
assert.equal(bSeek.disabled,false);
assert.equal(nodes['top-decks-scrub-row-1'].className,'top-decks-scrub-row');
assert.equal(nodes['top-decks-scrub-row-2'].className,'top-decks-scrub-row');
assert.equal(nodes['top-decks-scrub-row-1'].container,'A','Deck A scrub lives after its own miniature waveform');
assert.equal(nodes['top-decks-scrub-row-2'].container,'B','Deck B scrub lives after its own miniature waveform');
assert.equal(nodes['top-decks-scrub-row-2'].id,'top-decks-scrub-row-2');
assert.equal(nodes['top-decks-preview-play-2'].attrs['aria-label'],'Play local preview on Deck B');
assert.equal(nodes['top-decks-scrub-row-2'].id,'top-decks-scrub-row-2');
assert.equal(nodes['top-decks-seek-2'].attrs['aria-label'],'Seek Deck B local audio preview');
assert(nodes['top-decks-mini-position-1']&&nodes['top-decks-mini-position-2'],
  'both deck mini waveforms carry their own position markers');
assert.equal(nodes['top-decks-mini-position-1'].hidden,false,'staged A position appears inside its waveform');
assert.equal(nodes['top-decks-mini-position-2'].hidden,false,'staged B position appears inside its waveform');
const timelineStyle=nodes['injected-wave-style'].textContent;
assert(timelineStyle.includes('.top-decks-mini-position{position:absolute;z-index:2;width:2px'),
  'position cursor is a thin line in the waveform');
assert(timelineStyle.includes('clip-path:inset(50%)!important'),
  'oversized separate white scrub bar is visually hidden while keeping keyboard access');
bSeek.value='700'; bSeek.handlers.input();
assert.equal(audios.length,1,'B creates only one local audio player');
assert(audios[0].src.endsWith('id=2'),'B uses its own staged track');
assert(texts.includes('CUE REQUESTED · 0:07'),'no unverified playback claims before metadata');
assert.equal(aSeek.value,'0','B seek leaves A unchanged');
audios[0].readyState=1;audios[0].emit('loadedmetadata');
assert.equal(audios[0].currentTime,7,'B seeks real audio after metadata');
assert(texts.includes('LOCAL PREVIEW · 0:07 · PAUSED'));
nodes['top-decks-preview-play-2'].handlers.click();
assert.equal(audios[0].paused,false,'B play button controls B local audio');
assert.equal(nodes['top-decks-preview-play-2'].textContent,'Ⅱ');
nodes['top-decks-preview-play-2'].handlers.click();
assert.equal(audios[0].paused,true,'second press pauses B');
aSeek.value='500';aSeek.handlers.input();
assert.equal(audios.length,2,'A creates independent local audio player');
assert(audios[1].src.endsWith('id=1'));
audios[1].readyState=1;audios[1].duration=3;audios[1].emit('loadedmetadata');
assert.equal(audios[1].currentTime,1.5);
assert.equal(bSeek.value,'700','A seek leaves B unchanged');
assert.equal(nodes['top-decks-scrub-row-1'].children[1].textContent,'0:01','deck displays real elapsed time');
assert.equal(nodes['top-decks-scrub-row-2'].children[3].textContent,'0:10','deck displays total duration');
window.MusicHubTopDecks.setCrossfade(0);
assert(Math.abs(audios[1].volume-1)<.001&&Math.abs(audios[0].volume)<.001,'actual local audio A is audible at left end');
window.MusicHubTopDecks.setCrossfade(1);
assert(Math.abs(audios[0].volume-1)<.001&&Math.abs(audios[1].volume)<.001,'actual local audio B is audible at right end');
window.MusicHubTopDecks.setDeck(2,{track:{id:'2',length:10,bpm:120},detail,verified:true,positionSeconds:4});
assert.equal(bSeek.disabled,true,'verified Rekordbox B cannot be scrubbed');
assert.equal(audios[0].src,'','B audio is released on verified feedback');
assert.equal(window.MusicHubTopDecks.seekDeck(1,.9),false,'verified B rejects programmatic seek');
window.MusicHubTopDecks.setDeck(1,{track:{id:'3',length:8,bpm:120},detail});
assert.equal(audios[1].src,'','old A audio released when track changes');
audios[1].currentTime=2.8;audios[1].emit('timeupdate');
assert.equal(aSeek.value,'0','old A audio cannot jump the newly staged track');
let prevented=0;
deckWaveA.handlers.pointerdown({clientX:500,clientY:10,preventDefault(){prevented++}});
assert.equal(prevented,1,'direct waveform tap initiates local seeking');
assert.equal(audios.length,3,'direct A waveform click prepares A audio');
assert(audios[2].src.endsWith('id=3'));
assert(Number(aSeek.value)>0,'clicking ahead of fixed white line advances the A timeline');
deckWaveB.handlers.pointerdown({clientX:500,clientY:60,preventDefault(){prevented++}});
assert.equal(prevented,1,'verified B ignores direct waveform taps');
window.MusicHubTopDecks.setDeck(1,{track:{id:'4',length:8,bpm:120},detail});
const footerAudio=audioElement();footerAudio.readyState=1;footerAudio.duration=8;footerAudio.paused=false;
footerAudio.getAttribute=name=>name==='data-track'?'4':null;
nodes['preview-audio']=footerAudio;
const beforeFooterSeek=audios.length;
assert.equal(window.MusicHubTopDecks.seekDeck(0,.75),true,'seek routes to matching active footer audio');
assert.equal(footerAudio.currentTime,6,'real existing audio clock is advanced');
assert.equal(audios.length,beforeFooterSeek,'does not open a duplicate local audio source');
assert.equal(aSeek.value,'750','timeline reflects real footer preview seek');
window.MusicHubTopDecks.setDeck(1,{track:{id:'4',length:8,bpm:120},detail,verified:true,positionSeconds:4});
assert.equal(window.MusicHubTopDecks.seekDeck(0,.25),false,'verified Rekordbox A remains read-only');
assert.equal(footerAudio.currentTime,6,'verified A cannot change local footer audio');
// Rekordbox-like waveform grabbing: drag left to move forward, one lane only.
window.MusicHubTopDecks.setDeck(1,{track:{id:'5',length:20,bpm:120},detail});
window.MusicHubTopDecks.setDeck(2,{track:{id:'6',length:20,bpm:120},detail});
const expanded=nodes['top-decks-wave-canvas'];
let dragPrevented=0;
expanded.handlers.pointerdown({button:0,pointerId:11,clientX:450,clientY:18,preventDefault(){dragPrevented++}});
expanded.handlers.pointermove({pointerId:11,clientX:322,clientY:18,preventDefault(){dragPrevented++}});
assert.equal(aSeek.value,'50','A dragged 128 pixels left at 120 BPM scrubs forward by one second');
assert.equal(bSeek.value,'0','dragging A does not seek deck B');
assert(Number.parseFloat(nodes['top-decks-mini-position-1'].style.left)>20,
  'thin white marker moves along the mini waveform when expanded lane is scrubbed');
expanded.handlers.pointerup({pointerId:11});
assert.equal(expanded.style.cursor,'grab','release resets the grab affordance');
expanded.handlers.pointermove({pointerId:11,clientX:0,clientY:18,preventDefault(){dragPrevented++}});
assert.equal(aSeek.value,'50','pointer motion after release cannot move the track');
expanded.handlers.pointerdown({button:0,pointerId:12,clientX:450,clientY:66,preventDefault(){dragPrevented++}});
expanded.handlers.pointermove({pointerId:12,clientX:194,clientY:66,preventDefault(){dragPrevented++}});
assert.equal(bSeek.value,'100','B dragged 256 pixels left scrubs forward two seconds');
assert.equal(aSeek.value,'50','dragging B leaves A alone');
expanded.handlers.pointercancel({pointerId:12});
assert(dragPrevented>=4,'valid expanded waveform drags stop native gestures');
window.MusicHubTopDecks.setDeck(2,{track:{id:'6',length:20,bpm:120},detail,verified:true,positionSeconds:3});
const beforeGuard=aSeek.value;
expanded.handlers.pointerdown({button:0,pointerId:13,clientX:450,clientY:66,preventDefault(){throw Error('verified deck must not start drag')}});
expanded.handlers.pointermove({pointerId:13,clientX:250,clientY:66,preventDefault(){throw Error('verified deck must not seek')}});
assert.equal(aSeek.value,beforeGuard,'verified Rekordbox lane cannot trigger another deck seek');
assert.equal(bSeek.disabled,true,'verified deck stays read-only after attempted drag');
'''
        result = subprocess.run(['node', '-e', code, str(SCRIPT)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
