// Simulated decoded events exercise the browser bridge without real MIDI or audio.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(__dirname+'/../music-hub/physical-flx4-controls.js','utf8');
const elements=new Map(),calls=[];
function element(id=''){
  return {id,dataset:{},textContent:'',className:'',listeners:{},
    setAttribute(){},addEventListener(k,cb){this.listeners[k]=cb;},
    append(...nodes){nodes.forEach(n=>elements.set(n.id,n));}};
}
const document={readyState:'complete',getElementById:id=>elements.get(id)||null,
  createElement:()=>element(),body:element('body')};
let socket;
class WebSocket{
  constructor(){socket=this;this.callbacks={};}
  addEventListener(event,fn){this.callbacks[event]=fn;}
  send(){}
  close(){}
  fire(event,payload){this.callbacks[event]?.(payload);}
}
const methods={setCrossfade:1,setChannelFader:2,setEq:3,setFilter:2,setTempo:2,
  setFXLevel:2,jogDeck:3,touchJogDeck:3,cueDeck:1,syncDeck:1,
  setHeadphoneCue:2,toggleFX:1,fxBeatDown:1,fxBeatUp:1,
  fxSelectNext:1,fxSelectPrev:1,triggerHotCue:3,beatJump:3,beatLoop:3,
  triggerPadFX:3,setMasterLevel:1,setTrim:2,setHeadphoneMix:1,
  setHeadphoneLevel:1,setMicLevel:1,toggleMasterHeadphone:0,
  loopIn:1,loopOut:1,loopFourBeat:1,loopExit:1,loopHalf:1,loopDouble:1,
  shiftPlayDeck:1,shiftCueDeck:1,jogShiftDeck:2};
const mixer={localStatus:()=>({deckA:'100',deckB:'101'})};
for(const name of Object.keys(methods))mixer[name]=(...args)=>{calls.push([name,...args]);return true;};
let samplerMode='deck',samplerEngine='browser';
const sampler={status:()=>({mode:samplerMode,engine:samplerEngine}),
  trigger:pad=>{calls.push(['sampler',pad]);return Promise.resolve(true);}};
const controller={verified:()=>({a:false,b:false}),selectedId:()=> '100',
  browseBack:()=>{calls.push(['browserBack']);return true;}};
const window={MusicHubDesktopController:controller,MusicHubTopDecks:mixer,MusicHubSampler:sampler};
vm.runInNewContext(source,{window,document,WebSocket,Date,Math,Number,JSON,Map,setTimeout,clearTimeout,Promise});
socket.fire('open');
const event=data=>window.MusicHubPhysicalFLX4.processPhysical({source:'physical_flx4',...data});
const wsEvent=data=>socket.fire('message',{data:JSON.stringify({source:'physical_flx4',...data})});
assert.equal(event({action:'hardware_crossfader',value:0}),true);
assert.equal(event({action:'hardware_crossfader',value:1}),true);
assert.equal(event({action:'hardware_crossfader',value:0.37}),true);
assert.equal(event({action:'hardware_channel_fader',deck:1,value:.75}),true);
assert.equal(event({action:'hardware_eq',deck:2,band:'mid',value:.5}),true);
assert.equal(event({action:'hardware_cfx',deck:2,value:0}),true);
assert.equal(event({action:'hardware_tempo',deck:1,value:1}),true);
assert.equal(event({action:'hardware_fx_level',unit:2,value:.4}),true);
assert.equal(event({action:'hardware_master_level',value:.8}),true);
assert.equal(event({action:'hardware_trim',deck:1,value:.25}),true);
assert.equal(event({action:'hardware_headphone_mix',value:.6}),true);
assert.equal(event({action:'hardware_headphone_level',value:.7}),true);
assert.equal(event({action:'hardware_mic_level',value:.15}),true);
assert.equal(event({action:'hardware_jog_rotate',deck:2,delta:-3,mode:'pitch'}),true);
assert.equal(event({action:'hardware_jog_rotate',deck:1,delta:4,mode:'shift'}),true);
assert.equal(event({action:'hardware_jog_touch',deck:1,touched:true}),true);
assert.equal(event({action:'hardware_button',deck:1,pressed:true,control:'shift'}),true);
assert.equal(window.MusicHubPhysicalFLX4.status().shiftHeld[1],true);
assert.equal(event({action:'hardware_button',deck:1,pressed:false,control:'shift'}),true);
assert.equal(window.MusicHubPhysicalFLX4.status().shiftHeld[1],false);
assert.equal(event({action:'hardware_button',deck:1,pressed:true,control:'shift_play'}),true);
assert.equal(event({action:'hardware_button',deck:2,pressed:true,control:'shift_cue'}),true);
assert.equal(event({action:'hardware_button',deck:1,pressed:true,control:'cue'}),true);
assert.equal(event({action:'hardware_button',deck:2,pressed:true,control:'sync'}),true);
assert.equal(event({action:'hardware_button',deck:1,pressed:true,control:'headphone'}),true);
assert.equal(event({action:'hardware_button',deck:1,pressed:true,control:'headphone'}),true);
assert.equal(event({action:'hardware_button',unit:2,pressed:true,control:'fx_toggle'}),true);
assert.equal(event({action:'hardware_button',pressed:true,control:'master_headphone'}),true);
assert.equal(event({action:'hardware_button',deck:1,pressed:true,control:'loop_in'}),true);
assert.equal(event({action:'hardware_button',deck:2,pressed:true,control:'loop_out'}),true);
assert.equal(event({action:'hardware_button',deck:1,pressed:true,control:'loop_4beat'}),true);
assert.equal(event({action:'hardware_button',deck:2,pressed:true,control:'loop_exit'}),true);
assert.equal(event({action:'hardware_button',deck:1,pressed:true,control:'loop_half'}),true);
assert.equal(event({action:'hardware_button',deck:2,pressed:true,control:'loop_double'}),true);
assert.equal(event({action:'hardware_button',pressed:true,control:'browser_back'}),true);
assert.equal(event({action:'hardware_pad_mode',deck:1,mode:'hotcue',pressed:true}),true);
assert.equal(event({action:'hardware_pad',deck:1,pad:3,mode:'hotcue',pressed:true}),true);
assert.equal(event({action:'hardware_pad',deck:2,pad:1,mode:'beatjump',pressed:true,shifted:true}),true);
assert.equal(event({action:'hardware_pad_mode',deck:2,mode:'sampler',pressed:true}),true);
samplerMode='sampler';
wsEvent({action:'hardware_pad',deck:2,pad:7,mode:'sampler',pressed:true});
wsEvent({action:'hardware_pad',deck:1,pad:0,mode:'padfx1',pressed:true});
assert.deepEqual(calls.slice(-2),[['sampler',16],['sampler',1]],
  'browser mode must directly trigger each physical pad once, preserving the two 8-pad banks');
samplerEngine='vsl';
const beforeNative=calls.length;
assert.equal(event({action:'hardware_pad',deck:1,pad:3,mode:'padfx2',pressed:true}),true);
samplerEngine='direct';
assert.equal(event({action:'hardware_pad',deck:2,pad:5,mode:'sampler',pressed:true}),true);
assert.equal(calls.length,beforeNative,
  'VSL and direct engines handle physical pads themselves and must not be triggered again');
samplerEngine='unrecognized';
assert.equal(event({action:'hardware_pad',deck:1,pad:2,mode:'sampler',pressed:true}),false);
assert.equal(event({action:'hardware_crossfader',value:NaN}),false);
assert.equal(event({action:'hardware_eq',deck:1,band:'unknown',value:.5}),false);
assert.equal(event({action:'hardware_channel_fader',deck:3,value:.2}),false);
assert.equal(event({action:'hardware_pad',deck:1,pad:8,pressed:true,mode:'sampler'}),false);
assert.equal(event({action:'hardware_pad',deck:1,pad:0,pressed:false,mode:'sampler'}),false);
samplerMode='deck';
assert.equal(event({action:'hardware_pad',deck:1,pad:0,pressed:true,mode:'sampler'}),false);
assert.equal(event({action:'hardware_button',deck:1,pressed:false,control:'cue'}),false);
assert.equal(event({action:'hardware_button',deck:3,pressed:true,control:'loop_half'}),false);
assert.equal(event({action:'hardware_jog_rotate',deck:1,delta:1,mode:'unknown'}),false);
// Missing optional APIs must never fall back to PLAY or ordinary jog seek.
const shiftedJog=mixer.jogShiftDeck,halfLoop=mixer.loopHalf;
delete mixer.jogShiftDeck;delete mixer.loopHalf;
assert.equal(event({action:'hardware_jog_rotate',deck:1,delta:2,mode:'shift'}),false);
assert.equal(event({action:'hardware_button',deck:1,pressed:true,control:'loop_half'}),false);
mixer.jogShiftDeck=shiftedJog;mixer.loopHalf=halfLoop;
assert.equal(event({action:'hardware_crossfader',value:.5,source:'other'}),false);
const expected=[
  ['setCrossfade',0],['setCrossfade',1],['setCrossfade',.37],
  ['setChannelFader',1,.75],['setEq',2,'mid',.5],['setFilter',2,0],
  ['setTempo',1,1],['setFXLevel',2,.4],['setMasterLevel',.8],
  ['setTrim',1,.25],['setHeadphoneMix',.6],['setHeadphoneLevel',.7],
  ['setMicLevel',.15],['jogDeck',2,-3,'pitch'],['jogShiftDeck',1,4],
  ['touchJogDeck',1,true,false],['shiftPlayDeck',1],['shiftCueDeck',2],['cueDeck',1],['syncDeck',2],
  ['setHeadphoneCue',1,true],['setHeadphoneCue',1,false],
  ['toggleFX',2],['toggleMasterHeadphone'],['loopIn',1],['loopOut',2],
  ['loopFourBeat',1],['loopExit',2],['loopHalf',1],['loopDouble',2],
  ['browserBack'],['triggerHotCue',1,3,false],['beatJump',2,1,true],
  ['sampler',16],['sampler',1]
];
assert.deepEqual(calls,expected);
assert.equal(calls.filter(call=>call[0]==='sampler').length,2,
  'only the two browser engine presses should call sampler.trigger');
assert.equal(elements.get('physical-flx4-pad-mode').textContent,'Deck 2 · SAMPLER');
assert.equal(window.MusicHubPhysicalFLX4.status().headphone[1],false);
console.log('PASS: physical FLX4 mixer, EQ, tempo, jog, cue, FX and 16 sampler pads routed with invalid events ignored');
