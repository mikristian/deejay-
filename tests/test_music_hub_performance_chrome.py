"""Read-only UI contract for expanded performance chrome."""
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1] / "music-hub"


class PerformanceChromeContract(unittest.TestCase):
    def test_script_parses(self):
        subprocess.run(["node", "--check", str(ROOT / "performance-chrome.js")], check=True)

    def test_read_only_and_expand_gating(self):
        script = (ROOT / "performance-chrome.js").read_text()
        styles = (ROOT / "performance-chrome.css").read_text()
        self.assertIn("window.MusicHubPerformanceChrome = {init,sync}", script)
        self.assertIn("disabled aria-disabled=\"true\"", script)
        self.assertIn("UI PREVIEW", script)
        self.assertIn("root.dataset.pcReady === 'true'", script)
        self.assertIn(".performance.expanded .pc-effects", styles)
        self.assertIn(".performance.expanded .pc-deck-extra", styles)
        self.assertIn("display:none", styles)
        self.assertIn("@media(max-width:680px)", styles)

    def test_rekordbox_effect_assignments_and_mirrored_cues(self):
        script = (ROOT / "performance-chrome.js").read_text()
        styles = (ROOT / "performance-chrome.css").read_text()
        for label in ("ECHO", "FILTER", "SPIRAL", "VINYL BRAKE", "DEFAULT", "USER", "AUTO", "TAP", "FX1", "FX2", "CFX", "INST", "VOCAL", "DRUMS"):
            with self.subTest(effect=label):
                self.assertIn(label, script)
        self.assertIn("'1','2','S','3','4','M'", script)
        self.assertIn("'ABCDEFGH'", script)
        self.assertIn("grid-auto-flow:column", styles)
        self.assertIn(".pc-deck-stage-1 .pc-jog-unit{grid-column:2;grid-row:1}", styles)
        self.assertIn(".pc-deck-stage-2 .pc-jog-unit{grid-column:1;grid-row:1}", styles)
        self.assertIn(".pc-deck-stage-1 .pc-pad-panel{order:1}", styles)
        self.assertIn(".pc-deck-stage-2 .pc-pad-panel{order:2}", styles)

    def test_cue_play_and_sync_are_visual_previews(self):
        script = (ROOT / "performance-chrome.js").read_text()
        styles = (ROOT / "performance-chrome.css").read_text()
        self.assertIn("disabled aria-disabled=\"true\"", script)
        self.assertIn("KEY SYNC", script)
        self.assertIn("BEAT SYNC", script)
        self.assertIn("MASTER", script)
        self.assertIn("Playback position not verified", script)
        self.assertIn("verifiedPosition===null?'POS —':'POS VERIFIED'", script)
        self.assertIn("verifiedPosition===null", script)
        self.assertIn("formatTime(length)", script)
        for control in ("pc-jump-size", "SLIP", "Q", "MT", "pc-fx-menu-button", "pc-fx-dot"):
            with self.subTest(control=control):
                self.assertIn(control, script)
        self.assertIn("button.pc-inst{color:#ff9e9e", styles)
        self.assertIn("button.pc-vocal{color:#8cf4b1", styles)
        self.assertIn("button.pc-drums{color:#9fbaff", styles)
        self.assertIn("button.pc-cfx-filter{color:#f1f7ff", styles)
        self.assertIn("pc-fx-vinyl", script)
        self.assertIn(".pc-fx-slots{display:grid;grid-template-columns:repeat(4,minmax(0,1fr)) 54px", styles)
        self.assertIn(".pc-fx-timing{grid-column:5;grid-row:2", styles)
        self.assertIn(".pc-fx-slot-row>span:after{content:'⌄'", styles)


if __name__ == "__main__":
    unittest.main()
