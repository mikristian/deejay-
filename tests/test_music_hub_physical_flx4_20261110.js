// Exercise real physical controller handlers against a synthetic DOM/WebSocket.
// No MIDI messages or sound leave this offline harness.
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(__dirname+'/../music-hub/physical-flx4-controls.js','utf8');
const elements=new Map(),actions=[];
function el(id=''){
  return {id,hidden:false,dataset:{},className:'',textContent:'',
    listeners:{},attrs:{},setAttribute(k,v){this.attrs[k]=v;},
    addEventListener(name,fn){this.listeners[name]=fn;},
    append(...nodes){for(const node of nodes){elements.set(node.id,node);}},
    click(){this.listeners.click?.({});}};
}
const top=el('top');top.append=(...nodes)=>{for(const node of nodes)elements.set(node.id,node);};
const document={readyState:'complete',getElementById:id=>elements.get(id)||null,
  querySelector:sel=>sel==='#performance-panel .performance-top'?top:null,
  createElement:()=>el(),addEventListener(){},body:el('body')};
document.body.append=(...nodes)=>{for(const node of nodes)elements.set(node.id,node);};
let socket;
class FakeSocket{
  constructor(url){assert.strictEqual(url,'ws://127.0.0.1:18765');this.listeners={};socket=this;}
  addEventListener(k,fn){this.listeners[k]=fn;}
  send(data){assert.deepStrictEqual(JSON.parse(data),{type:'status_request'});}
  fire(k,data){this.listeners[k]?.(data);}
  close(){this.listeners.close?.();}
}
let current='101',verified={a:false,b:false};
const local={deckA:null,deckB:null};
const hub={
  selectedId:()=>current,
  firstPlayableId:()=> '101',
  select:id=>{current=id;actions.push(['select',id]);return true;},
  track:id=>({101:{title:'Song A'},102:{title:'Song B'}}[id]||null),
  browse:n=>{actions.push(['browse',n]);current='102';return true;},
  stage:(n,id)=>{actions.push(['load',n,id]);local[n===1?'deckA':'deckB']=id;return true;},
  verified:()=>verified
};
const decks={localStatus:()=>({...local}),
  playDeck:n=>{actions.push(['play',n]);return true;}};
let now=10000;
class FakeDate extends Date {static now(){now+=300;return now;}}
const context={window:{MusicHubDesktopController:hub,MusicHubTopDecks:decks},
  document,WebSocket:FakeSocket,Date:FakeDate,Map,Number,Math,JSON,setTimeout,clearTimeout};
vm.runInNewContext(source,context);
const ctl=context.window.MusicHubPhysicalFLX4;
assert.strictEqual(ctl.status().enabled,true,'this laptop must listen for the physical controller on startup');
assert(elements.has('physical-flx4-panel'),'status indicator must not be hidden by library focus view');
assert.strictEqual(ctl.processPhysical({source:'physical_flx4',action:'hardware_browser_rotate',delta:1}),false);
socket.fire('open');
socket.fire('message',{data:JSON.stringify({action:'controller_status',status:{
  physical_controller_monitor:{connected:true}}})});
assert.strictEqual(elements.get('physical-flx4-dot').dataset.state,'connected');
assert.strictEqual(ctl.status().ready,true);
const event=data=>ctl.processPhysical({source:'physical_flx4',...data});
assert.strictEqual(event({action:'hardware_browser_rotate',delta:1}),true);
// The first PLAY must stage selected track automatically, not silently do nothing.
assert.strictEqual(event({action:'hardware_button',pressed:true,deck:1,control:'play'}),true);
assert.strictEqual(event({action:'hardware_button',pressed:true,control:'browser_press'}),true);
assert.strictEqual(event({action:'hardware_button',pressed:true,deck:2,control:'load'}),true);
assert.strictEqual(event({action:'hardware_button',pressed:false,deck:1,control:'play'}),false);
assert.strictEqual(ctl.processPhysical({source:'remote',action:'hardware_button',
  pressed:true,deck:2,control:'play'}),false);
assert.strictEqual(event({action:'hardware_button',pressed:true,deck:3,control:'play'}),false);
assert.deepStrictEqual(actions,[['browse',1],['load',1,'102'],['play',1],['load',1,'102'],['load',2,'102']]);
socket.fire('message',{data:JSON.stringify({source:'physical_flx4',
  action:'hardware_button',pressed:true,deck:2,control:'play'})});
assert.deepStrictEqual(actions.at(-1),['play',2],'real websocket event must call mixer transport');
local.deckA=null;current=null;
assert.strictEqual(event({action:'hardware_button',pressed:true,deck:1,control:'play'}),true,
  'PLAY must choose first playable track when library has no selected row and deck is empty');
assert.deepStrictEqual(actions.slice(-3),[['select','101'],['load',1,'101'],['play',1]]);
verified={a:true,b:false};
assert.strictEqual(event({action:'hardware_button',pressed:true,deck:2,control:'play'}),false,
  'verified native deck must prevent local duplicate play');
elements.get('physical-flx4-toggle').click();
assert.strictEqual(ctl.status().enabled,false,'explicit OFF still available');
console.log('PASS: live WebSocket connects; FLX4 knob selects; PLAY auto-stages and plays; LOAD A/B stages; OFF and Rekordbox guards work');
