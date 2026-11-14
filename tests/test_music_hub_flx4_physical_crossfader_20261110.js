// Crossfader acceptance bookkeeping is simulated here. Never report this
// synthetic suite as proof of real motor/finger movement or speaker output.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/../music-hub/physical-flx4-controls.js','utf8');
const elements=new Map();
function el(id=''){
  return {id,textContent:'',dataset:{},listeners:{},setAttribute(){},
    addEventListener(name,handler){this.listeners[name]=handler;},
    append(...nodes){for(const node of nodes)elements.set(node.id,node);}};
}
const document={readyState:'complete',body:el('body'),
  createElement:()=>el(),getElementById:id=>elements.get(id)||null};
let socket;
class FakeSocket{
  constructor(){socket=this;this.handlers={};}
  addEventListener(name,handler){this.handlers[name]=handler;}
  send(){}
  close(){}
  fire(name,argument){this.handlers[name]?.(argument);}
}
let crossfade=.5;
const gain=()=>[Math.cos(crossfade*Math.PI/2),Math.sin(crossfade*Math.PI/2)];
const mixer={
  setCrossfade(v){crossfade=v;return true;},
  mixerState(){return {crossfade,masterGain:gain()};},
  localStatus(){return {playingA:false,playingB:false};}
};
const window={
  MusicHubDesktopController:{verified:()=>({a:false,b:false})},
  MusicHubTopDecks:mixer
};
vm.runInNewContext(source,{window,document,WebSocket:FakeSocket,Date,JSON,Number,Math,Map,
  Promise,setTimeout,clearTimeout});
socket.fire('open');
socket.fire('message',{data:JSON.stringify({action:'controller_status',status:{
  physical_controller_monitor:{connected:true}}})});
const controller=window.MusicHubPhysicalFLX4;
function send(event){socket.fire('message',{data:JSON.stringify({
  source:'physical_flx4',action:'hardware_crossfader',...event})});}
assert.equal(controller.status().physicalCrossfader.samples,0);
// Native test controls without a stamped physical MIDI event are not proof.
send({value:0,diagnosticTest:true});
send({value:1});
assert.equal(controller.status().physicalCrossfader.samples,0);
assert.equal(controller.status().physicalCrossfader.complete,false);
const at=Date.now()/1000;
send({value:0,hardware_at:at});
send({value:.5,hardware_at:at});
send({value:1,hardware_at:at});
const sweep=controller.status().physicalCrossfader;
assert.equal(sweep.samples,3);
assert.equal(sweep.left,true);
assert.equal(sweep.center,true);
assert.equal(sweep.right,true);
assert.equal(sweep.complete,true);
assert.equal(sweep.lastValue,1);
assert.ok(sweep.lastGains[0]<.0001&&sweep.lastGains[1]>.9999,
  'The last hardware-stamped position must reach the actual mixer gain');
assert.match(elements.get('physical-flx4-sweep').textContent,/PHYSICAL CROSSFADE SWEEP RECEIVED/);
const before=sweep.samples;
send({value:.3,hardware_at:at,diagnosticTest:true});
assert.equal(controller.status().physicalCrossfader.samples,before);
console.log('PASS: physical-stamped crossfader LEFT/CENTER/RIGHT sweep recorded; synthetic does not count');
