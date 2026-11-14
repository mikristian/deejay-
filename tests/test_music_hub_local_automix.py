"""Verified local automix sequence; real audio mixing stays in TopDecks."""
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1] / 'music-hub'


class LocalAutomixTests(unittest.TestCase):
    def test_script_parses_and_is_loaded_by_desktop(self):
        script = ROOT / 'local-automix.js'
        subprocess.run(['node', '--check', str(script)], check=True, capture_output=True)
        page = (ROOT / 'index.html').read_text()
        self.assertIn('local-automix.js?', page)
        self.assertIn('top-decks-waveform.js?', page)

    def test_real_queue_controls_both_staged_audio_decks_and_finishes(self):
        code = r'''
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const nodes={},staged=[],cleared=[],intervals=[],fades=[],crossfades=[];
function el(id){
  return {id,textContent:'',handlers:{},attrs:{},setAttribute(k,v){this.attrs[k]=v},
    addEventListener(name,fn){this.handlers[name]=fn},
    append(...children){for(const child of children)nodes[child.id]=child}};
}
const top=el('performance-top');
const document={readyState:'complete',
  querySelector(sel){return sel==='#performance-panel .performance-top'?top:null},
  createElement(tag){return el(tag)},
  getElementById(id){return nodes[id]||null}};
const state={deckA:null,deckB:null,positionA:0,positionB:0,durationA:30,durationB:30,
  playingA:false,playingB:false,errorA:false,errorB:false,verifiedA:false,verifiedB:false,
  autoFading:false};
const controller={
  queue(){return ['1','2','3']},track(id){return ['1','2','3'].includes(id)?{id}:null},
  verified(){return {a:state.verifiedA,b:state.verifiedB}},
  stage(n,id){staged.push([n,id]);state['deck'+(n===1?'A':'B')]=id;return true},
  clear(n){cleared.push(n);state['deck'+(n===1?'A':'B')]=null;return true}};
const audio={
  localStatus(){return {...state}},
  setCrossfade(n){crossfades.push(n)},
  startDeck(n){state['playing'+(n===1?'A':'B')]=true;return true},
  autoTransition(n){fades.push(n);state.autoFading=true;return true}};
const window={MusicHubTopDecks:audio,MusicHubDesktopController:controller};
vm.runInNewContext(fs.readFileSync(process.argv[1],'utf8'),
  {window,document,setInterval(fn){intervals.push(fn);return intervals.length},
   clearInterval(){},Date,Math,Number,String});
const button=nodes['local-automix-toggle'];
assert(button&&button.handlers.click,'Auto Mix is an actionable native button');
button.handlers.click();
assert.equal(window.MusicHubLocalAutomix.status().running,true);
assert.equal(button.textContent,'STOP AUTO MIX');
assert.deepEqual(staged,[[1,'1'],[2,'2']]);
assert.deepEqual(crossfades,[0]);
state.positionA=26;intervals[0]();
assert.equal(fades.length,1,'a near-end song triggers audible local crossfade');
assert.equal(window.MusicHubLocalAutomix.status().phase,'transition');
state.autoFading=false;state.playingA=false;state.playingB=true;intervals[0]();
assert.deepEqual(staged,[[1,'1'],[2,'2'],[1,'3']],'next queued song loads into freed deck');
assert.equal(window.MusicHubLocalAutomix.status().source,2);
state.positionB=26;intervals[0]();
assert.equal(fades.length,2,'second transition scheduled for last song');
state.autoFading=false;state.playingB=false;state.playingA=true;intervals[0]();
assert.deepEqual(cleared,[2],'old track removed so last song cannot loop back');
state.positionA=30;state.playingA=false;intervals[0]();
assert.equal(window.MusicHubLocalAutomix.status().running,false);
assert.equal(button.textContent,'AUTO MIX SET');
assert.equal(nodes['local-automix-status'].textContent,'Local set finished.');
state.verifiedA=true;
button.handlers.click();
assert.equal(window.MusicHubLocalAutomix.status().running,false,'verified hardware blocks local automix');
'''
        result = subprocess.run(
            ['node', '-e', code, str(ROOT / 'local-automix.js')],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
