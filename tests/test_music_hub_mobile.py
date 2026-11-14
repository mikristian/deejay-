"""Static integration checks for the standalone Music Hub companion page."""
import html.parser
from pathlib import Path
import shutil
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1] / "music-hub"


class PageParser(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = set()
        self.assets = []
        self.buttons = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            self.ids.add(attrs["id"])
        if tag == "script":
            self.assets.append(attrs.get("src"))
        if tag == "link" and attrs.get("rel") == "stylesheet":
            self.assets.append(attrs.get("href"))
        if tag == "button":
            self.buttons.append(attrs)


class MobilePageTest(unittest.TestCase):
    def test_paired_companion_keeps_playlist_detail_compact(self):
        page = (ROOT / "mobile.html").read_text()
        source = (ROOT / "mobile.js").read_text()
        css = (ROOT / "mobile.css").read_text()
        self.assertIn('id="edit-pairing"', page)
        self.assertIn("$('pairing').hidden=!remote||!pairingOpen", source)
        self.assertIn("if(button.id==='edit-pairing')", source)
        self.assertIn("spotlight.hidden=!!detail", source)
        self.assertIn(".spotlight[hidden]{display:none!important}", css)
        self.assertIn("#browse-panel .browse-title[hidden]", css)
        self.assertIn("#browse-panel .chips[hidden]", css)

    def test_page_assets_and_controls(self):
        p = PageParser()
        p.feed((ROOT / "mobile.html").read_text())
        self.assertIn("./mobile.js", p.assets)
        self.assertIn("./mobile.css", p.assets)
        for asset in p.assets:
            self.assertTrue((ROOT / asset).is_file())
        for panel in ("browse", "search", "queue", "decks"):
            self.assertIn(panel + "-panel", p.ids)
            self.assertTrue(any(b.get("data-tab") == panel for b in p.buttons))
        self.assertEqual({"1", "2"}, {b["data-deck"] for b in p.buttons if "data-deck" in b})

    def test_remote_and_playback_guards(self):
        source = (ROOT / "mobile.js").read_text()
        self.assertIn("localOrigin && state.hubReady", source)
        self.assertIn("!state.decksVerified", source)
        self.assertIn("response.load_verified===true", source)
        self.assertIn("queue.reorder", source)
        self.assertIn("/api/music-hub/action", source)
        self.assertNotIn("playback.start", source)
        self.assertNotIn("auto.mix", source)

    def test_local_audio_commands_use_expiring_capability_and_queued_feedback(self):
        page = (ROOT / "mobile.html").read_text()
        source = (ROOT / "mobile.js").read_text()
        self.assertIn('id="local-audio"', page)
        self.assertIn('aria-labelledby="local-audio-title" hidden', page)
        self.assertIn('LOCAL AUDIO', page)
        self.assertIn('not Rekordbox hardware', page)
        self.assertIn('data-local-play="1"', page)
        self.assertIn('data-local-play="2"', page)
        self.assertIn('data-local-seek="1"', page)
        self.assertIn('data-local-seek="2"', page)
        for element in ("local-fade-send", "local-fade-duration", "local-fade-target",
                        "local-automix-start", "local-automix-stop", "local-audio-feedback"):
            self.assertIn(f'id="{element}"', page)
        self.assertIn('state.capabilities.localPreviewRemote===true', source)
        self.assertIn('await refreshRemoteStatus()', source)
        self.assertIn("'/api/remote/v1/command'", source)
        for action in ("local.play", "local.seek", "local.fade", "local.autoMixStart", "local.autoMixStop"):
            self.assertIn(f"action:'{action}'", source)
        self.assertIn('response.accepted!==true', source)
        self.assertIn('Execution and playback are not verified.', source)
        self.assertIn('sec>86400', source)
        self.assertIn('durationMs<100||durationMs>30000', source)
        self.assertIn('setInterval(', source)

    def test_local_preview_telemetry_requires_valid_fresh_status(self):
        page = (ROOT / "mobile.html").read_text()
        source = (ROOT / "mobile.js").read_text()
        for element in ("local-live-a", "local-live-b"):
            self.assertIn(f'id="{element}"', page)
        self.assertIn("const PREVIEW_FIELDS=", source)
        for key in ("deckA", "deckB", "playingA", "playingB",
                    "positionA", "positionB", "durationA", "durationB",
                    "crossfade", "autoFading"):
            self.assertIn(f"'{key}'", source)
        self.assertIn('Object.keys(value).length!==PREVIEW_FIELDS.length', source)
        self.assertIn('Number.isFinite(value[key])', source)
        self.assertIn('validPreview(status.preview)', source)
        self.assertIn('state.capabilities.localPreviewRemote===true?', source)
        self.assertIn('const preview=localAudioActive()?state.preview:null', source)
        self.assertIn("node.textContent='LOCAL · No fresh preview data'", source)
        self.assertIn('state.preview=null', source)
        self.assertIn("localTime(position)+' / '+localTime(duration)", source)
        self.assertNotIn('Date.now()', source)

    def test_stage_buttons_are_distinct_from_deck_target_intentions(self):
        page = (ROOT / "mobile.html").read_text()
        source = (ROOT / "mobile.js").read_text()
        for deck in ("1", "2"):
            self.assertIn(f'data-local-stage="{deck}"', page)
            self.assertIn(f'data-deck="{deck}"', page)
        self.assertIn("Stage on laptop A", page)
        self.assertIn("Stage on laptop B", page)
        self.assertIn('localAudioActive()', source)
        self.assertIn('selectedLocalId()', source)
        self.assertIn(r'/^\d{1,20}$/.test(str(state.selected))', source)
        self.assertIn("button.dataset.localStage", source)
        self.assertIn("queueLocalCommand({action:'local.stage',deck,trackId:str(id)}", source)
        self.assertIn("'/api/remote/v1/command'", source)
        self.assertIn("action:'enqueue',trackId:chosenId,deck:str(n)", source)
        self.assertIn('stageAwaiting[deck]={trackId:str(id),before}', source)
        self.assertIn("pending.before!==pending.trackId", source)
        self.assertIn("state.preview[deck==='1'?'deckA':'deckB']===pending.trackId", source)
        self.assertIn('A fresh preview heartbeat, not the command response, confirms staging.', source)

    def test_remote_header_and_capability_gated_harmonic_reorder(self):
        page = (ROOT / "mobile.html").read_text()
        source = (ROOT / "mobile.js").read_text()
        css = (ROOT / "mobile.css").read_text()
        self.assertIn('id="desktop-link" class="desktop" href="./index.html"', page)
        self.assertIn('id="desktop-remote-label" class="desktop" hidden', page)
        self.assertIn("location.port==='18770'", source)
        self.assertIn("$('desktop-link').hidden=remote", source)
        self.assertIn("$('desktop-remote-label').hidden=!remote", source)
        self.assertIn(".desktop[hidden]{display:none!important}", css)
        self.assertIn("state.capabilities.smartReorder!==true", source)
        self.assertIn("$('smart-order').hidden=remote?state.capabilities.smartReorder!==true: false", source)
        self.assertIn("action:'queue.reorder',from,to:i", source)

    def test_playlist_detail_keeps_identity_search_and_original_order(self):
        page = (ROOT / "mobile.html").read_text()
        source = (ROOT / "mobile.js").read_text()
        for element in ("playlist-detail", "playlist-back", "playlist-detail-title",
                        "playlist-detail-count", "playlist-detail-search", "browse-content"):
            self.assertIn(f'id="{element}"', page)
        self.assertIn("state.detail={kind,id:str(id),title}", source)
        self.assertIn("if(state.detail){renderDetail();return;}", source)
        self.assertIn("state.hub.playlists.find(p=>str(p.id)===state.detail.id)", source)
        self.assertIn("asList(item.trackIds).map(track).filter(Boolean)", source)
        self.assertIn("rows=query?detail.rows.filter(t=>matches(t,query)):detail.rows", source)
        self.assertIn("if(button.id==='playlist-back')return closeDetail()", source)
        self.assertIn("$('playlist-detail-search').addEventListener('input'", source)
        self.assertIn("if(button.dataset.album)return openDetail('album'", source)
        self.assertIn("if(button.dataset.playlist)return openDetail(button.dataset.playlistType==='native'?'native':'playlist'", source)

    def test_native_rekordbox_playlists_use_distinct_read_only_paths(self):
        source = (ROOT / "mobile.js").read_text()
        self.assertIn('nativePlaylists:[],nativeCache:new Map()', source)
        self.assertIn("asList(remote?data.nativePlaylists:data.playlists)", source)
        self.assertIn("...state.nativePlaylists.filter(p=>p.kind==='playlist')", source)
        self.assertIn("...state.hub.playlists.map(p=>", source)
        self.assertIn('data-playlist-type=', source)
        self.assertIn("p.type==='native'?'Rekordbox · Read-only':'Music Hub'", source)
        self.assertIn("/api/remote/v1/native-playlist?id=", source)
        self.assertIn("/api/playlist?id=", source)
        self.assertIn("const raw=remote?data.trackIds:Array.isArray(data.tracks)?data.tracks.map(t=>t?.id):null", source)
        self.assertIn("state.nativeCache.set(id", source)
        self.assertIn("ids.map(track).filter(Boolean)", source)
        self.assertIn("if(str(data.id)!==id)throw Error('Playlist ID mismatch')", source)
        self.assertIn("state.nativeCache.clear()", source)

    def test_large_native_playlists_render_bounded_batches(self):
        source = (ROOT / "mobile.js").read_text()
        self.assertIn("detailLimit:80", source)
        self.assertIn("renderList('browse-content',rows.slice(0,state.detailLimit))", source)
        self.assertIn("state.detailLimit+=80", source)
        self.assertIn("state.detailLimit=80;clearTimeout(searchTimer)", source)
        self.assertIn("const total=detail.kind==='native'?detail.count:detail.rows.length", source)
        self.assertIn("state.detailLimit>=rows.length", source)
        self.assertIn("rows=query?detail.rows.filter(t=>matches(t,query)):detail.rows", source)

    def test_swipes_reveal_accessible_explicit_deck_actions(self):
        source = (ROOT / "mobile.js").read_text()
        self.assertIn("'touchstart'", source)
        self.assertIn("'touchmove'", source)
        self.assertIn("'touchend'", source)
        self.assertIn("'touchcancel'", source)
        self.assertIn("Math.abs(dx)<55", source)
        self.assertIn("const deck=dx<0?'1':'2'", source)
        self.assertIn("showGesture(start.row,deck)", source)
        self.assertIn("if(!remote){notify(", source)
        self.assertIn("if(!canTarget()||!asList(state.capabilities.deckTargets).includes(deck))", source)
        self.assertIn("void loadDeck(Number(deck),start.id)", source)
        self.assertIn("event.timeStamp-lastAutoSwipe.at<1200", source)
        self.assertIn("touchStart.cancelled=true", source)
        self.assertIn('data-swipe-deck=', source)
        self.assertIn('data-swipe-stage=', source)
        self.assertIn('aria-label="', source)
        self.assertIn("if(button.dataset.swipeDeck)return loadDeck", source)
        self.assertIn("if(button.dataset.swipeStage)return stageTrack", source)
        self.assertIn("!asList(state.capabilities.deckTargets).includes(str(n))", source)
        self.assertIn("state.remoteQueue.revision,action:'enqueue'", source)
        self.assertIn("await refreshRemoteStatus()", source)

    @unittest.skipUnless(shutil.which("node"), "Node.js not installed")
    def test_touch_swipe_directly_queues_remote_intents_only(self):
        # Exercise the actual installed handlers. Touch interaction needs behavior
        # checks: static source assertions alone cannot catch accidental playback.
        harness = r"""
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(process.argv[1],'utf8');
const section='  let touchStart=null;'+source.split('  let touchStart=null;')[1].split("  document.addEventListener('click'")[0];
const handlers={},loads=[],prompts=[],reveals=[];
const row={isConnected:true,dataset:{track:'42'}};
const target={closest(selector){return selector==='.track[data-track]'?row:null;}};
const point=(x,y)=>({identifier:7,clientX:x,clientY:y});
const context={
 document:{addEventListener(name,fn){handlers[name]=fn;}},
 track:id=>id==='42'?{id,title:'Song'}:null,
 showGesture:(r,d)=>reveals.push(d),
 loadDeck:(d,id)=>{loads.push([d,id]);return Promise.resolve();},
 notify:(s,error)=>prompts.push([s,!!error]),
 deckLabel:d=>d==='1'?'A':'B',
 asList:v=>Array.isArray(v)?v:[],
 canTarget:()=>context.paired,
 state:{capabilities:{deckTargets:['1','2']}},
 remote:true,paired:true
};
vm.runInNewContext(section,context);
function start(){handlers.touchstart({target,touches:[point(100,200)]});}
function end(x,y,t){handlers.touchend({touches:[],changedTouches:[point(x,y)],timeStamp:t});}
start();end(20,205,1000);
assert.deepStrictEqual(loads,[[1,'42']]);
start();end(20,205,1050); // same song, same deck, rapid duplicate
assert.strictEqual(loads.length,1);
start();end(185,205,1200);
assert.deepStrictEqual(loads,[[1,'42'],[2,'42']]);
start();end(20,205,2400);
assert.strictEqual(loads.length,3);
start();handlers.touchmove({touches:[point(94,235)]});end(0,330,3600);
assert.strictEqual(loads.length,3,'vertical scrolling must not enqueue');
start();end(50,205,3800);
assert.strictEqual(loads.length,3,'short swipe must not enqueue');
handlers.touchstart({target:{closest:()=>({})},touches:[point(100,200)]});end(0,205,4000);
assert.strictEqual(loads.length,3,'interactive controls must not enqueue');
context.paired=false;start();end(20,205,5100);
assert.strictEqual(loads.length,3);
assert.ok(prompts.at(-1)[1],'unsupported remote needs explicit warning');
context.paired=true;context.state.capabilities.deckTargets=['2'];start();end(20,205,6200);
assert.strictEqual(loads.length,3,'missing Deck A capability must not enqueue');
context.remote=false;context.state.capabilities.deckTargets=['1','2'];start();end(20,205,7300);
assert.strictEqual(loads.length,3,'localhost must not auto-load native Rekordbox deck');
assert.ok(reveals.length>=4,'swipes should keep manual controls available');
start();handlers.touchcancel({});end(20,205,8400);
assert.strictEqual(loads.length,3);
"""
        result = subprocess.run(
            ["node", "-e", harness, str(ROOT / "mobile.js")],
            capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(0, result.returncode, result.stderr)

    def test_sticky_waveform_is_from_validated_measured_analysis_only(self):
        page = (ROOT / "mobile.html").read_text()
        source = (ROOT / "mobile.js").read_text()
        for side in ("a", "b"):
            for part in ("mini-deck-wave", "mini-deck-title", "mini-deck-time",
                         "mini-state", "mini-deck-progress"):
                self.assertIn(f'id="{part}-{side}"', page)
        self.assertIn("'/api/remote/v1/waveform?id='+encodeURIComponent(id)", source)
        self.assertIn("str(data?.id)!==id", source)
        self.assertIn("wave.serial!==serial||wave.id!==id", source)
        self.assertIn("data.heights.every(v=>typeof v==='number'", source)
        self.assertIn("wrap.classList.toggle('has-data',values.length>0)", source)
        self.assertIn("const preview=localAudioActive()?state.preview:null", source)
        self.assertIn("line.hidden=!hasTiming", source)
        self.assertIn("position/duration*100", source)
        self.assertNotIn("Math.random", source)

    @unittest.skipUnless(shutil.which("node"), "Node.js not installed")
    def test_javascript_parses(self):
        result = subprocess.run(
            ["node", "--check", str(ROOT / "mobile.js")],
            capture_output=True, text=True, timeout=15,
        )
        self.assertEqual(0, result.returncode, result.stderr)


if __name__ == "__main__":
    unittest.main()
