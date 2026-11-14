const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('right-click tracks exposes safe rekordbox-style commands without writing to rekordbox', () => {
  const listeners = new Map();
  const nodes = new Map();
  let active = null;
  class Element {
    constructor(tag='div') {this.tag=tag;this.dataset={};this.children=[];this.attrs={};this.style={};this.hidden=false;this.isConnected=true;this.textContent='';}
    append(...items) {this.children.push(...items);for(const item of items)if(item.id)nodes.set(item.id,item);}
    setAttribute(key,value) {this.attrs[key]=value;}
    addEventListener(type,fn) {if(!listeners.has(this))listeners.set(this,new Map());listeners.get(this).set(type,fn);}
    getBoundingClientRect() {return {width:305,height:450};}
    focus() {active=this;}
    contains(target) {return target===this||this.children.some(x=>x.contains?.(target));}
    querySelector(selector) {if(selector==='button')return this.find(x=>x.tag==='button');return null;}
    querySelectorAll(selector) {return selector==='button:not([disabled])'?this.flatten().filter(x=>x.tag==='button'&&!x.disabled):[];}
    flatten() {return [this,...this.children.flatMap(x=>x.flatten?.()||[x])];}
    find(fn) {return this.flatten().find(fn);}
    closest() {return null;}
  }
  const document={readyState:'complete',body:new Element('body'),activeElement:null,
    createElement: tag=>new Element(tag),
    addEventListener(type,fn) {if(!listeners.has(document))listeners.set(document,new Map());listeners.get(document).set(type,fn);},
    getElementById: id=>nodes.get(id)||null,
    querySelector() {return null;}};
  const window={innerWidth:1440,innerHeight:900,addEventListener(){}};
  const code=fs.readFileSync(path.resolve(__dirname,'../music-hub/track-context-menu.js'),'utf8');
  vm.runInNewContext(code,{Element,document,window,MouseEvent:class {constructor(type,opts){Object.assign(this,opts);this.type=type;} }});
  const menu=window.MusicHubTrackContextMenu.element;
  assert(menu.hidden,'menu hidden before right-click');
  assert(menu.flatten().some(x=>x.textContent==='Auto Load Hot Cue…'), 'native Hot Cue auto-load setting is clearly listed');
  assert(menu.flatten().some(x=>x.textContent==='Track Type…'), 'native track type is clearly listed');
  const triggered={playlist:0,queue:0,favorite:0};
  const row=new Element();row.dataset.id='987';
  const title=new Element();title.textContent='Known Test Track';
  row.querySelector=selector=>{
    if(selector==='.track-title')return title;
    const action=selector.match(/\[data-action="(.*?)"\]/)?.[1];
    if(!action)return null;
    return {isConnected:true,click:()=>{triggered[action]=(triggered[action]||0)+1;}};
  };
  row.closest=selector=>selector==='#scroller .track-row[data-id]'?row:null;
  const onContext=listeners.get(document).get('contextmenu');
  let prevented=0;
  onContext({target:row,clientX:140,clientY:260,preventDefault(){prevented++;},stopPropagation(){}});
  assert.equal(prevented,1);
  assert.equal(menu.hidden,false);
  assert.equal(menu.children[0].textContent,'Known Test Track');
  const button=id=>menu.find(x=>x.dataset?.trackMenuAction===id);
  listeners.get(button('playlist')).get('click')({stopPropagation(){}});
  assert.equal(triggered.playlist,1,'uses existing Music Hub playlist workflow');
  assert.equal(menu.hidden,true);
  onContext({target:row,clientX:140,clientY:260,preventDefault(){},stopPropagation(){}});
  listeners.get(button('autoload')).get('click')({stopPropagation(){}});
  assert.match(menu.children.at(-1).textContent,/configured in Rekordbox/i);
  assert.equal(menu.hidden,false,'unsupported native option explains instead of pretending success');
  const onKey=listeners.get(document).get('keydown');
  let closed=false;
  onKey({key:'Escape',preventDefault(){closed=true;},stopPropagation(){}});
  assert(closed);
  assert(menu.hidden);
  assert.equal(triggered.queue,0);
  assert.equal(triggered.favorite,0);
});
