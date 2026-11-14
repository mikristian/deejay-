const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const listeners = new Map();
const timers = new Map();
let nextTimer = 0, now = 1000, nativeMarkerClicks = 0;
class Element {
  constructor(kind, id = '') {
    this.kind = kind; this.id = id; this.dataset = {}; this.attributes = {};
    this.style = {values:{},setProperty(k,v){this.values[k]=v}};
    const values = new Set();
    this.classList = {add:x=>values.add(x),remove:x=>values.delete(x),contains:x=>values.has(x)};
    this.isConnected = true;
  }
  closest(selector) {
    if (selector === '#scroller .row-wave-button') return this.kind === 'wave' ? this : null;
    if (selector === '.track-row[data-id]') return this.row || null;
    return null;
  }
  contains(node) {return node === this;}
  getBoundingClientRect() {return {left:10,width:200};}
  setAttribute(k,v) {this.attributes[k]=v;}
  removeAttribute(k) {delete this.attributes[k];}
}
class MockAudio {
  constructor() {this.handlers={};this.paused=true;this.duration=100;this.currentTime=0;this.playCount=0;this.pauseCount=0;this.loadCount=0;}
  addEventListener(kind,cb) {this.handlers[kind]=cb;}
  setAttribute() {}
  removeAttribute(k) {if(k==='src')this.src='';}
  load(){this.loadCount++;}
  pause(){this.paused=true;this.pauseCount++;this.handlers.pause?.();}
  play(){this.paused=false;this.playCount++;return Promise.resolve();}
}
const audios=[];
function Audio(){const a=new MockAudio();audios.push(a);return a;}
const rows = ['11','22'].map(id => {const row=new Element('row');row.dataset.id=id;const button=new Element('wave');button.row=row;return button;});
const document={
  readyState:'complete',body:{appendChild(el){el.isConnected=true}},
  createElement(){return new Element('status')},
  addEventListener(type,fn){(listeners.get(type)||listeners.set(type,[]).get(type)).push(fn)},
  querySelectorAll(selector){return selector.includes('row-preview-playing')?rows.filter(r=>r.classList.contains('row-preview-playing')):[]},
  querySelector(selector){return rows.find(r=>selector.includes(r.row.dataset.id))||null}
};
const window={addEventListener(){}};
const context={window,document,Element,Audio,performance:{now:()=>now},setTimeout(fn,delay){const id=++nextTimer;timers.set(id,{fn,delay});return id},clearTimeout(id){timers.delete(id)}};
const script=fs.readFileSync(path.resolve(__dirname,'../music-hub/row-wave-preview.js'),'utf8');
vm.runInNewContext(script,context);
function dispatch(type,target,props={}) {
  const evt={type,target,button:0,pointerId:7,clientX:110,relatedTarget:null,key:'',defaultPrevented:false,
    preventDefault(){this.defaultPrevented=true},stopPropagation(){this.stopped=true},...props};
  for(const fn of listeners.get(type)||[]){fn(evt);if(evt.stopped)break;}
  if(type==='click'&&!evt.stopped)nativeMarkerClicks++;
  return evt;
}
async function tick(){await Promise.resolve();await Promise.resolve();}
function fireTimers(delay){for(const [id,t] of [...timers])if(t.delay===delay){timers.delete(id);t.fn();}}
(async()=>{
  const audio=window.MusicHubRowWavePreview.audio;
  assert.equal(audios.length,1,'only one new dedicated player');
  const deckAudio={paused:false,currentTime:17},footerAudio={paused:false,currentTime:34};
  // A pure hover places a white cursor but has no permission to autoplay yet.
  dispatch('pointerover',rows[0]);dispatch('pointermove',rows[0],{clientX:60});
  assert.equal(rows[0].style.values['--row-preview-x'],'25.000%');
  assert.match(rows[0].attributes['aria-label'],/Shift-click for cue markers/);
  assert.equal(audio.playCount,0);
  dispatch('pointerdown',rows[0],{clientX:60});
  assert.equal(audio.playCount,1,'plays within pointerdown user gesture');
  assert.equal(audio.currentTime,25);
  now+=80;
  dispatch('pointermove',rows[0],{clientX:160});
  assert.equal(audio.currentTime,75,'pointer drag seeks audio while still down');
  dispatch('pointerup',rows[0],{clientX:160});
  assert(dispatch('click',rows[0]).stopped,'synthetic click prevented from invoking markers');
  assert.equal(audio.playCount,1,'synthetic click did not trigger another play');
  assert.equal(nativeMarkerClicks,0);
  assert.equal(dispatch('click',rows[0],{shiftKey:true}).stopped,undefined,'Shift-click passes through to markers handler');
  assert.equal(nativeMarkerClicks,1);
  await tick();
  assert.equal(audio.paused,false);
  // Hover on another virtual row switches after a stable hover, not immediately.
  dispatch('pointerover',rows[1]);
  assert.equal(audio.src,'/api/music-hub/audio?id=11');
  fireTimers(250);await tick();
  assert.equal(audio.src,'/api/music-hub/audio?id=22');
  assert.equal(audio.playCount,2);
  assert.equal(rows[1].classList.contains('row-preview-playing'),true);
  assert.match(rows[1].attributes['aria-label'],/Click to preview|Preview playing/);
  // A click on the playing waveform stops it. Escape also stops after a new start.
  dispatch('pointerdown',rows[1]);dispatch('pointerup',rows[1]);
  assert.equal(audio.paused,true,'active row click stops preview');
  assert.equal(audio.src,'','stop clears preview source');
  dispatch('pointerdown',rows[0]);
  assert.equal(audio.paused,false);
  dispatch('pointercancel',rows[0]);
  assert.equal(audio.paused,true,'pointer cancellation stops newly started preview');
  dispatch('pointerdown',rows[0]);
  dispatch('pointerup',rows[0]);
  const escape=dispatch('keydown',rows[0],{key:'Escape'});
  assert(escape.defaultPrevented,'Escape consumes key when preview active');
  assert.equal(audio.paused,true);
  assert.equal(deckAudio.paused,false);assert.equal(deckAudio.currentTime,17);
  assert.equal(footerAudio.paused,false);assert.equal(footerAudio.currentTime,34);
  assert.equal(audios.length,1,'no extra audio instance after track switching');
  console.log('PASS: independent player, pointer scrub, hover unlock, stop, Escape, cancellation, click suppression');
})().catch(error=>{console.error(error);process.exitCode=1});
