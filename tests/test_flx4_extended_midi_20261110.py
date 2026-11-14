"""Official DDJ-FLX4 MIDI message contract, without touching the hardware.

Source: Pioneer DJ DDJ-FLX4 MIDI Message List, mixer and deck tables.
This checks only decode semantics, not real physical fader acquisition.
"""
import unittest

import mido
from flx4_physical import FLX4PhysicalMonitor


class ExtendedFLX4MIDITest(unittest.TestCase):
    def setUp(self):
        self.monitor = FLX4PhysicalMonitor()

    def cc(self, channel, control, value):
        return self.monitor.decode_message(mido.Message(
            "control_change", channel=channel, control=control, value=value))

    def note(self, channel, note, on=True):
        return self.monitor.decode_message(mido.Message(
            "note_on", channel=channel, note=note, velocity=127 if on else 0))

    def test_all_mixer_position_controls(self):
        cases = [
            (6, 0x1F, "hardware_crossfader", None),
            (6, 0x08, "hardware_master_level", None),
            (6, 0x0C, "hardware_headphone_mix", None),
            (6, 0x0D, "hardware_headphone_level", None),
            (6, 0x05, "hardware_mic_level", None),
            (0, 0x04, "hardware_trim", 1),
            (1, 0x04, "hardware_trim", 2),
            (0, 0x13, "hardware_channel_fader", 1),
            (1, 0x13, "hardware_channel_fader", 2),
            (0, 0x07, "hardware_eq", 1),
            (1, 0x0B, "hardware_eq", 2),
            (6, 0x17, "hardware_cfx", 1),
            (6, 0x18, "hardware_cfx", 2),
        ]
        for channel, control, action, deck in cases:
            with self.subTest(action=action, ch=channel, cc=control):
                low = self.cc(channel, control, 0)
                self.assertEqual(len(low), 1)
                self.assertEqual(low[0]["action"], action)
                self.assertEqual(low[0]["value"], 0)
                if deck:
                    self.assertEqual(low[0]["deck"], deck)
                high = self.cc(channel, control, 127)[0]
                self.assertAlmostEqual(high["value"], 1)
                self.assertEqual(high["precision"], "7bit-msb")
                # The paired LSB refines 127/127 to the exact full-scale 14-bit.
                full = self.cc(channel, control + 0x20, 127)[0]
                self.assertAlmostEqual(full["value"], 1)
                self.assertEqual(full["precision"], "14bit")

    def test_jog_side_and_shift_relative(self):
        for channel in (0, 1):
            for cc, mode in ((0x21, "pitch"), (0x22, "scratch"),
                             (0x23, "pitch"), (0x29, "shift")):
                for value, delta in ((65, 1), (63, -1)):
                    event = self.cc(channel, cc, value)[0]
                    self.assertEqual(event["action"], "hardware_jog_rotate")
                    self.assertEqual(event["deck"], channel + 1)
                    self.assertEqual(event["mode"], mode)
                    self.assertEqual(event["delta"], delta)

    def test_deck_loops_shift_and_master_headphone(self):
        modes = {
            0x3F: "shift", 0x0E: "shift_play", 0x48: "shift_cue",
            0x10: "loop_in", 0x11: "loop_out", 0x4D: "loop_4beat",
            0x50: "loop_exit", 0x51: "loop_half", 0x53: "loop_double",
        }
        for channel in (0, 1):
            for note, control in modes.items():
                on = self.note(channel, note)[0]
                self.assertEqual(on["control"], control)
                self.assertEqual(on["deck"], channel + 1)
                self.assertTrue(on["pressed"])
                self.assertFalse(self.note(channel, note, False)[0]["pressed"])
        master = self.note(6, 0x19)[0]
        self.assertEqual(master["control"], "headphone_master")


if __name__ == "__main__":
    unittest.main()
