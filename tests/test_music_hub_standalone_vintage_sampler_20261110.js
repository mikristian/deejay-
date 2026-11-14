// The 16-chop sampler belongs to its own application; never render or
// trigger its direct-audio voices a second time inside Music Hub.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'music-hub/index.html'),'utf8');
const chrome=fs.readFileSync(path.join(root,'music-hub/performance-chrome.js'),'utf8');
const swift=fs.readFileSync(path.join(root,'music-hub/native/MusicHub.swift'),'utf8');
for(const forbidden of ['id="sampler-lab"','id="sampler-launch"',
  'id="sampler-grid"','sampler.css','sampler.js']){
  assert.equal(html.includes(forbidden),false,'Music Hub still embeds '+forbidden);
}
assert.equal(chrome.includes('pc-sampler-strip'),false,
  'DJ Performance panel still offers an embedded sampler preview');
assert.match(swift,/Open Vintage Sampler Lab \(Separate App\)/);
assert.match(swift,/Applications\/Vintage Sampler Lab\.app/);

const source=fs.readFileSync(path.join(root,'music-hub/physical-flx4-controls.js'),'utf8');
const elements=new Map();
function element(id=''){
  return {id,dataset:{},style:{},textContent:'',listeners:{},
    setAttribute(){},addEventListener(type,callback){this.listeners[type]=callback;},
    append(...children){for(const child of children)elements.set(child.id,child);}};
}
const document={readyState:'complete',body:element('body'),
  createElement:()=>element(),getElementById:id=>elements.get(id)||null};
const calls=[];
let socket,refreshSampler,serverMode='sampler',serverEngine='direct';
class Socket{
  constructor(){socket=this;this.handlers={};}
  addEventListener(type,callback){this.handlers[type]=callback;}
  send(){}
  close(){}
  emit(type,value){this.handlers[type]?.(value);}
}
const window={MusicHubDesktopController:{verified:()=>({a:false,b:false})},
  MusicHubTopDecks:{
    triggerPadFX:(...args)=>{calls.push(['incorrect embedded FX',...args]);return true;},
    localStatus:()=>({playingA:false,playingB:false})
  }};
async function fakeFetch(path){
  assert.equal(path,'/api/music-hub/sampler/status');
  return {ok:true,json:async()=>({mode:serverMode,engine:serverEngine})};
}
vm.runInNewContext(source,{window,document,WebSocket:Socket,fetch:fakeFetch,
  setTimeout,clearTimeout,setInterval:callback=>{refreshSampler=callback;return 1;},
  Date,JSON,Number,Math,Map,Promise});
socket.emit('open');
const monitor=window.MusicHubPhysicalFLX4;
function physical(deck,pad,mode){
  return monitor.processPhysical({
    source:'physical_flx4',action:'hardware_pad',deck,pad,mode,pressed:true});
}
(async()=>{
  await new Promise(resolve=>setImmediate(resolve));
  const state=monitor.status().standaloneSampler;
  assert.equal(state.mode,'sampler');
  assert.equal(state.engine,'direct');
  assert.equal(physical(1,0,'padfx1'),true);
  assert.equal(physical(2,7,'sampler'),true);
  assert.deepEqual(calls,[], 'native direct FLX4 pad playback must not duplicate within Music Hub');
  assert.match(monitor.status().lastResult.reason,/handles hardware natively/);
  assert.equal(window.MusicHubSampler,undefined,
    'no Music Hub embedded sampler object should be required');
  serverEngine='ableton';
  await refreshSampler();
  assert.equal(monitor.status().standaloneSampler.engine,'ableton');
  assert.equal(physical(1,1,'padfx1'),true);
  assert.deepEqual(calls,[],
    'Ableton Sampler bridge owns physical chops, Music Hub must not trigger a second voice');
  console.log('PASS: standalone Vintage app, zero embedded pads, no duplicate direct/Ableton FLX4 chops');
})().catch(error=>{console.error(error);process.exitCode=1;});
