'use strict';
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');

async function main(){
  const calls=[];
  const decks=[{deck:1,trackId:0},{deck:2,trackId:0}];
  const audio={pauseCount:0,pause(){this.pauseCount++;},tagName:'AUDIO'};
  const listeners={};
  const api={
    setDeck(){return true;},preloadDeck(){return true;},
    playDeck(){throw Error('Web Audio played when Rust was active');},
    startDeck(){throw Error('Web Audio started when Rust was active');},
    seekDeck(){throw Error('Web Audio sought when Rust was active');},
    cueDeck(){throw Error('Web Audio cue played when Rust was active');},
    setCrossfade(){return true;},setChannelFader(){return true;},
    setMasterLevel(){return true;},setTrim(){return true;},
    setEq(){return true;},setFilter(){return true;},setTempo(){return true;},
    localStatus(){return {durationA:120,durationB:140};},
    mixerState(){return {trim:[.25,.6],tempo:[.5,.75]};}
  };
  const button={setAttribute(){},addEventListener(){},dataset:{}};
  const document={readyState:'complete',
    querySelector(){return {appendChild(){}};},
    querySelectorAll(){return [audio];},
    createElement(){return button;},
    addEventListener(type,fn){listeners[type]=fn;}};
  const context={
    window:{MusicHubTopDecks:api,webkit:{messageHandlers:{}},
      addEventListener(){},dispatchEvent(){}},
    navigator:{userAgent:'AppleWebKit'},document,
    CustomEvent:class {constructor(type,opts){this.type=type;this.detail=opts.detail;}},
    AbortController,setTimeout,clearTimeout,setInterval(){},
    fetch:async(url,config={})=>{
      const body=config.body?JSON.parse(config.body):undefined;
      calls.push({url,body});
      let response={ok:true};
      if(url.endsWith('/health')||url.endsWith('/status'))response={ok:true,audioStreamStarted:true,decks};
      else if(url.endsWith('/command')){
        if(body?.action==='load')decks[body.deck-1].trackId=Number(body.trackId);
        response=body?.action==='load'?{accepted:true}: {ok:true};
      }else throw Error('Unexpected endpoint '+url);
      return {ok:true,text:async()=>JSON.stringify(response)};
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'native-rust-audio.js'),'utf8'),context);
  const rust=context.window.MusicHubRustAudio;
  await rust.health();
  assert.equal(rust.status().engine,'web','Rust must be off initially');
  api.setDeck(1,{track:{id:1234},verified:false});
  api.setDeck(2,{track:{id:5678},verified:false});
  assert.equal(await rust.activate(),true);
  assert.equal(audio.pauseCount>0,true);
  assert.equal(rust.status().engine,'rust');
  assert(calls.some(c=>c.body?.action==='trim'&&c.body.deck===1&&c.body.value===.25),
    'Activation must forward normalized trim unchanged');
  assert(calls.some(c=>c.body?.action==='tempo'&&c.body.deck===1&&Math.abs(c.body.value-1/3)<1e-10),
    'Activation tempo .5 must map to Rust speed 1.0');
  assert.equal(api.playDeck(1),true);
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(api.cueDeck(1),false);
  assert.equal(api.seekDeck(0,.25),true);
  assert.equal(api.setCrossfade(.3),true);
  assert.equal(api.setEq(2,'mid',.7),true);
  assert.equal(api.setTempo(1,.5),true);
  assert.equal(api.setTempo(2,.9),true);
  assert.equal(api.setTrim(1,.4),true);
  await new Promise(resolve=>setTimeout(resolve,0));
  assert(calls.some(c=>c.body?.action==='play'&&c.body.deck===1));
  assert(calls.some(c=>c.body?.action==='seek'&&c.body.value===.25),
    'Rust seek must receive normalized fraction, not seconds');
  assert(calls.some(c=>c.body?.action==='crossfade'&&c.body.value===.3));
  assert(calls.some(c=>c.body?.action==='eq'&&c.body.band==='mid'&&c.body.deck===2));
  assert(calls.some(c=>c.body?.action==='tempo'&&c.body.deck===1&&Math.abs(c.body.value-1/3)<1e-10));
  assert(calls.some(c=>c.body?.action==='tempo'&&c.body.deck===2&&Math.abs(c.body.value-.6)<1e-10),
    'Live tempo normalized .9 must map to Rust value .6');
  assert(calls.some(c=>c.body?.action==='trim'&&c.body.deck===1&&c.body.value===.4),
    'Live trim must forward normalized value unchanged');
  assert(calls.every(c=>!c.url.includes('/load')&&!c.url.includes('/transport')&&!c.url.includes('/mixer')));
  await rust.deactivate();
  assert.equal(rust.status().engine,'web');
  assert.equal(rust.status().playing[0],false);
  console.log('Rust Music Hub adapter: activation, confirmed tracks, isolated Web transport, command mapping and rollback PASS');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
