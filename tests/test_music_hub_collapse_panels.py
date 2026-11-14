"""Regression guard: waveform and Up Next arrows are separately controllable."""
from html.parser import HTMLParser
from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1] / "music-hub"


class _Markup(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = {}

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if attributes.get("id"):
            self.ids[attributes["id"]] = {"tag": tag, **attributes}


class IndependentCollapseControls(unittest.TestCase):
    def test_javascript_parses(self):
        for filename in ("top-decks-waveform.js", "app.js", "performance-chrome.js"):
            with self.subTest(filename=filename):
                subprocess.run(["node", "--check", str(ROOT / filename)], check=True,
                               capture_output=True, text=True)

    def test_up_next_arrow_is_a_real_accessible_button(self):
        html = _Markup()
        html.feed((ROOT / "index.html").read_text())
        control = html.ids["harmonic-rail-toggle"]
        self.assertEqual(control["tag"], "button")
        self.assertEqual(control["aria-controls"], "harmonic-rail-scroll")
        self.assertEqual(control["aria-expanded"], "true")
        js = (ROOT / "app.js").read_text()
        css = (ROOT / "styles.css").read_text()
        self.assertIn("function setHarmonicRailCollapsed(", js)
        self.assertIn("music-hub-up-next-collapsed-v1", js)
        self.assertIn("$('harmonic-rail-toggle').addEventListener('click'", js)
        self.assertIn(".harmonic-rail.is-collapsed .harmonic-rail-scroll{display:none", css)

    def test_waveform_arrow_folds_both_lanes_only(self):
        script = (ROOT / "top-decks-waveform.js").read_text()
        css = (ROOT / "styles.css").read_text()
        self.assertIn("top-decks-wave-expand", script)
        self.assertIn("aria-controls=\"top-decks-wave-canvas\"", script)
        self.assertIn("music-hub-waveforms-collapsed-v2", script)
        self.assertIn("button?.addEventListener('click',()=>setCompact(!collapsed))", script)
        self.assertIn("event.code==='KeyW'", script)
        self.assertIn("top-decks-wave-strip.collapsed .top-decks-wave-collapsed-hint{display:flex}", css)
        self.assertIn("const desiredHeight=collapsed?26:", script)
        self.assertIn("var(--pc-wave-height,", script)
        self.assertNotIn(".classList.toggle('library-focus'", script)
        self.assertNotIn("music-hub-up-next-collapsed-v1", script)

    def test_waveform_color_style_control_does_not_obscure_lane_labels(self):
        script = (ROOT / "top-decks-waveform.js").read_text()
        self.assertIn("panel.querySelector('.performance-top')?.append(styleButton)", script)
        self.assertNotIn("strip.append(styleButton)", script)
        self.assertIn("3-BAND COLOR", script)
        self.assertIn("ANALYSIS RGB", script)

    def test_waveform_beat_ticks_require_recorded_analysis(self):
        script = (ROOT / "top-decks-waveform.js").read_text()
        self.assertIn("return explicit.filter(t=>t>=start-1&&t<=end+1);", script)
        self.assertNotIn("Math.floor(start/period)", script)
        self.assertIn("bpm:finite(bpm)&&bpm>0?bpm:0", script)
        self.assertIn("if(!beats.length)return '—'", script)

    def test_expanded_fx_mixer_scrolls_without_covering_the_song_browser(self):
        css = (ROOT / "styles.css").read_text()
        js = (ROOT / "app.js").read_text()
        self.assertIn(".shell>.performance.expanded{max-height:min(59dvh,620px);overflow-y:auto", css)
        self.assertIn("SCROLL ↓ FOR JOGS + HOT CUES", js)


if __name__ == "__main__":
    unittest.main()
