const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/../music-hub/top-decks-waveform.js','utf8');
const nodes=[];
function param(value=0){return {value,setTargetAtTime(v){this.value=v;}};}
function node(){const n={gain:param(1),frequency:param(),Q:param(),connect(x){this.next=x;},disconnect(){this.next=null;}};nodes.push(n);return n;}
class Context{
  constructor(){this.destination={};this.currentTime=0;this.state='running';}
  createGain(){return node();}
  createBiquadFilter(){return node();}
  createMediaElementSource(audio){const n=node();n.audio=audio;return n;}
}
const audio=[];
const document={readyState:'loading',addEventListener(){},getElementById(){return null;},createElement(name){
  if(name!=='audio')throw Error(name);
  const a={paused:true,ended:false,volume:1,playbackRate:1,preservesPitch:false,currentTime:0,readyState:1,
    listeners:{},setAttribute(){},removeAttribute(){},load(){},addEventListener(k,fn){this.listeners[k]=fn;},
    pause(){this.paused=true;},play(){this.paused=false;return Promise.resolve();}};
  audio.push(a);return a;
}};
const window={AudioContext:Context,addEventListener(){}};
vm.runInNewContext(source,{window,document,fetch(){return Promise.resolve({ok:true,json:async()=>({markers:[]})});},
  setInterval,clearInterval,Number,Math,Date,Map,Set,Promise});
const decks=window.MusicHubTopDecks;
decks.setDeck(1,{track:{id:101,length:200}});
decks.setDeck(2,{track:{id:102,length:180}});
assert.equal(decks.preloadDeck(1),true);
assert.equal(decks.preloadDeck(2),true);
assert.equal(decks.setChannelFader(1,.2),true);
assert.equal(decks.setChannelFader(2,.9),true);
assert.equal(decks.setCrossfade(0),true);
// preloadDeck now constructs the complete Web Audio graph before PLAY.
// HTMLMediaElement volume must remain unity: apply each fader exactly once
// in its Web Audio gain node, not a second time in audio.volume.
assert.equal(audio[0].volume,1);
assert.equal(audio[1].volume,1);
assert.ok(nodes.some(n=>n.gain.value===.2),'Deck A channel gain is .2');
assert.ok(nodes.some(n=>n.gain.value===0),'Deck B is muted by crossfader');
assert.equal(decks.setEq(1,'low',1),true);
assert.equal(decks.setEq(2,'mid',0),true);
assert.equal(decks.setFilter(1,0),true);
assert.equal(decks.setTempo(1,1),true);
assert.equal(decks.playDeck(1),true);
assert.equal(audio[0].volume,1,'Web Audio source must not double attenuate media volume');
assert.equal(audio[0].playbackRate,1.5);
assert.equal(decks.mixerState().audioContextState,'running');
assert.equal(decks.mixerState().audioGraphConnected[0],true);
assert.equal(decks.mixerState().masterGain[0],.2);
assert.equal(decks.setMasterLevel(.3),true);
assert.equal(decks.mixerState().masterLevel,.3);
assert.equal(decks.setTrim(1,.75),true);
assert.equal(decks.mixerState().trim[0],.75);
assert.ok(nodes.some(n=>n.gain.value===1.5));
assert.equal(decks.setHeadphoneMix(.25),true);
assert.equal(decks.setHeadphoneLevel(.4),true);
assert.equal(decks.mixerState().headphoneMix,.25);
assert.equal(decks.mixerState().headphoneLevel,.4);
assert.equal(decks.setTrim(3,.5),false);
assert.equal(decks.setMasterLevel(NaN),false);
assert.ok(nodes.some(n=>n.type==='lowshelf'&&n.gain.value===12));
assert.ok(nodes.some(n=>n.type==='lowpass'&&n.frequency.value<=181));
assert.ok(nodes.some(n=>n.gain.value===.2));
assert.equal(decks.setCrossfade(1),true);
assert.ok(nodes.some(n=>n.gain.value===0));
// Starting/pausing a deck must not override the DJ's actual hardware
// crossfader position; a prior behavior silently snapped to the playing deck.
assert.equal(decks.playDeck(1),true);
assert.equal(decks.mixerState().crossfade,1);
assert.equal(decks.setHeadphoneCue(1,true),true);
assert.equal(decks.localStatus().headphoneCue[0],true);
assert.equal(decks.cueDeck(1),true);
assert.equal(decks.jogDeck(1,10,'scrub'),true);
assert.ok(audio[0].currentTime>=0);
assert.equal(decks.setEq(1,'invalid',1),false);
assert.equal(decks.setChannelFader(3,1),false);
assert.equal(decks.setTempo(2,NaN),false);
console.log('PASS WebAudio gain, crossfade, EQ, filter, speed, cue/jog and input validation');
