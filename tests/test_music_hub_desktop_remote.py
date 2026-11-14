"""Paired desktop only executes authenticated, scoped local preview commands."""
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1] / 'music-hub'


class DesktopRemoteTests(unittest.TestCase):
    def test_module_is_loaded_and_valid_javascript(self):
        subprocess.run(['node', '--check', str(ROOT / 'desktop-remote.js')], check=True)
        self.assertIn('desktop-remote.js?', (ROOT / 'index.html').read_text())

    def test_pairing_origin_auth_commands_and_acknowledgement(self):
        script = r'''
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const calls=[],events=[],stored=new Map(),token='a'.repeat(40);
const state={deckA:'12',deckB:'34',durationA:100,durationB:90,
 playingA:false,playingB:true,positionA:0,positionB:24,crossfade:.5,autoFading:false};
const window={MusicHubDesktopController:{
  stage(deck,id){events.push(['stage',deck,id]);return deck===2&&id==='42'}
},MusicHubTopDecks:{
  localStatus(){return state},
  playDeck(n){events.push(['play',n]);return true},
  seekDeck(n,p){events.push(['seek',n,p]);return true},
  fadeTo(t,s){events.push(['fade',t,s]);return true}
},MusicHubLocalAutomix:{
  running:false,
  start(){this.running=true;events.push(['automix','start'])},
  stop(){this.running=false;events.push(['automix','stop'])},
  status(){return {running:this.running}}
}};
const commands=[
  {id:'7'.repeat(32),action:'local.stage',args:{deck:'2',trackId:'42'}},
  {id:'1'.repeat(32),action:'local.play',args:{deck:'1'}},
  {id:'2'.repeat(32),action:'local.seek',args:{deck:'2',positionSec:45}},
  {id:'3'.repeat(32),action:'local.fade',args:{target:1,durationMs:2500}},
  {id:'4'.repeat(32),action:'local.autoMixStart',args:{}},
  {id:'5'.repeat(32),action:'local.autoMixStop',args:{}},
  {id:'6'.repeat(32),action:'native.master.db.modify',args:{}}
];
const document={readyState:'loading',addEventListener(){},getElementById(){return null}};
const sessionStorage={setItem(k,v){stored.set(k,v)},getItem(k){return stored.get(k)||null},removeItem(k){stored.delete(k)}};
const fetch=async (url,options)=>{
  calls.push({url,options});
  const path=new URL(url).pathname;
  const payload=path.endsWith('/commands')?{commands}:path.endsWith('/ack')?{acknowledged:true}:{active:true};
  return {ok:true,json:async()=>payload};
};
const sandbox={window,document,sessionStorage,fetch,setInterval(){return 1},clearInterval(){},Date,Number,String,URL};
vm.runInNewContext(fs.readFileSync(process.argv[1],'utf8'),sandbox);
(async()=>{
 const control=window.MusicHubDesktopRemote;
 assert.equal(await control.connect('http://example.com:18770',token),false,'external hostname forbidden');
 assert.equal(await control.connect('http://127.0.0.1:18770/foo',token),false,'unexpected path forbidden');
 assert.equal(calls.length,0,'invalid URLs never receive bearer token');
 assert.equal(await control.connect('http://127.0.0.1:18770',token),true);
 assert.equal(control.status().active,true);
 assert(calls.every(c=>c.url.startsWith('http://127.0.0.1:18770/api/remote/v1/')));
 assert(calls.every(c=>c.options.headers.Authorization==='Bearer '+token));
 assert(calls.every(c=>c.options.credentials==='omit'&&c.options.redirect==='error'));
 const beats=calls.find(c=>c.url.endsWith('/heartbeat'));
 const stateSent=JSON.parse(beats.options.body).preview;
 assert.equal(stateSent.positionB,24,'real elapsed time forwarded in sanitized preview');
 assert.deepEqual(events[0],['stage',2,'42']);
 assert.deepEqual(events[1],['play',1]);
 assert.deepEqual(events[2],['seek',1,.5]);
 assert.deepEqual(events[3],['fade',1,2.5]);
 assert.equal(events.length,6,'unknown native/hardware actions rejected');
 assert.equal(calls.filter(c=>c.url.endsWith('/ack')).length,7,'every delivered command acknowledged');
 control.stop();
 assert.equal(control.status().active,false);
 assert.equal(stored.size,0,'disconnect clears token');
})().catch(error=>{console.error(error);process.exitCode=1});
'''
        result = subprocess.run(['node', '-e', script, str(ROOT / 'desktop-remote.js')], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
