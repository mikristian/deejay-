"""Full-size Rekordbox harmonic ordering remains deterministic and responsive."""
from pathlib import Path
import subprocess
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "music-hub" / "harmonic-order.js"


class HarmonicOrderPerformance(unittest.TestCase):
    def test_large_playlist_mixes_without_loss_or_mutation(self):
        js = r'''
const assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks');
const order=require(process.argv[1]);
const input=Array.from({length:5779},(_,i)=>({
  id:String(i+1),title:'Song '+i,
  camelot:i%31===0?'':(i%12+1)+(i%2?'A':'B'),
  bpm:i%19===0?null:Math.round(70+(i%118)*.5),
}));
const snapshot=JSON.stringify(input);
const started=performance.now();
const output=order(input);
const duration=performance.now()-started;
assert.equal(output.length,input.length,'all original tracks must remain');
assert.equal(new Set(output.map(t=>t.id)).size,input.length,'no duplicate or lost IDs');
assert.equal(output[0],input.find(t=>t.camelot),'the first analyzed song stays the starting point');
assert.equal(JSON.stringify(input),snapshot,'the original playlist must not be mutated');
const missingKey=output.filter(t=>!t.camelot);
assert.equal(missingKey.length,input.filter(t=>!t.camelot).length);
assert(output.slice(-missingKey.length).every(t=>!t.camelot),'unknown Camelot keys at end');
assert(duration<10000,'DJ-sized playlist ordering must be responsive: '+duration+'ms');
const half=order([{id:'a',camelot:'8A',bpm:80},{id:'b',camelot:'8A',bpm:160},{id:'c',camelot:'8A',bpm:123}]);
assert.equal(half[1].id,'b','correctly recognizes double-time tempo compatibility');
console.log('ordered',output.length,'tracks in',Math.round(duration),'ms');
'''
        result = subprocess.run(["node", "-e", js, str(SCRIPT)], capture_output=True,
                                text=True, timeout=18)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_syntax(self):
        result = subprocess.run(["node", "--check", str(SCRIPT)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
