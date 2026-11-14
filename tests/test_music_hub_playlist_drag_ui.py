"""Guard the native Music Hub's read-only Rekordbox / mutable Hub drag UX."""
from pathlib import Path
import subprocess
import unittest


UI = Path(__file__).resolve().parents[1] / 'music-hub'


class PlaylistDragUI(unittest.TestCase):
    def test_js_validates(self):
        for file in ('app.js', 'harmonic-order.js', 'top-decks-waveform.js'):
            with self.subTest(file=file):
                subprocess.run(['node','--check',str(UI/file)],check=True,capture_output=True)

    def test_track_dragging_to_deck_queue_and_local_playlist(self):
        app = (UI/'app.js').read_text()
        for clause in ("setData('application/x-music-hub-track'", "deck.addEventListener('drop'",
                       "$('scroller').addEventListener('drop'", "'playlist.reorder'",
                       "$('sidebar').addEventListener('drop'", "'playlist.add'",
                       "$('queue-items').addEventListener('drop'", "'queue.add'",
                       "dragging>=0?'move':'copy'", "'Rekordbox playlists are read-only here"):
            with self.subTest(clause=clause):
                self.assertIn(clause, app)
        self.assertIn('playlist.trackIds.indexOf(source.trackId)',app)
        self.assertIn('playlist.trackIds.indexOf(row.dataset.id)',app)

    def test_artwork_search_smart_reorder_and_compact_rail(self):
        app = (UI/'app.js').read_text()
        css = (UI/'playlist-polish.css').read_text()
        self.assertIn("artwork:g.artwork",app)
        self.assertIn("playlistCover(p)",app)
        self.assertIn("playlist-sidebar-art",app)
        self.assertIn("Search this playlist…",app)
        self.assertIn("trackIds:ids.slice()",app)
        self.assertIn("ids.length>6000",app)
        self.assertIn("height:54px;min-height:54px;max-height:54px",css)
        self.assertIn(".track-drop-target",css)
        self.assertIn(".playlist-drop-target",css)

    def test_harmonic_preview_preserves_all_tracks_unknown_keys_last(self):
        js = f"""const order=require({str(UI/'harmonic-order.js')!r});
const input=[{{id:'a',camelot:'8A',bpm:123}},{{id:'b',camelot:'10A',bpm:124}},
{{id:'u',camelot:'',bpm:110}},{{id:'c',camelot:'9A',bpm:125}}];
const got=order(input).map(x=>x.id); if(got.length!==4||got[0]!=='a'||got[1]!=='c'||got[3]!=='u')process.exit(4);
"""
        subprocess.run(['node','-e',js],check=True,capture_output=True)

    def test_real_local_audio_position_drives_scrolling_waveform_only(self):
        app=(UI/'app.js').read_text()
        wave=(UI/'top-decks-waveform.js').read_text()
        for expected in ('function syncLocalWaveform(reset=false)',
                         'syncLocalPreview?.({trackId:id,positionSeconds:',
                         'advanceLocalWaveAnimation(timestamp)',
                         'requestAnimationFrame(advanceLocalWaveAnimation)',
                         "player().addEventListener('timeupdate'",
                         'stopLocalWaveAnimation(true)'):
            with self.subTest(expected=expected):self.assertIn(expected,app)
        self.assertIn('slot.verified||slot.trackId!==id',wave)
        self.assertIn('LOCAL PREVIEW · ${time}',wave)
        self.assertIn('STAGED PREVIEW · 0:00',wave)


if __name__ == '__main__':
    unittest.main()
