# music-hub-core (stage 1)

Pure Rust control-state prototype for the staged Music Hub audio migration.
No runtime services, MIDI device handles, audio output, track reads, or Rekordbox DB access.
The existing Swift/JS/Python Music Hub continues operating as before.

Build and test:

```sh
cd rust/music-hub-core
~/.cargo/bin/cargo test
```

API: validate a `Unit` from a bounded value or MIDI 7/14-bit fields; parse `MidiCc`
without guessing its meaning; let an explicit future FLX4 mapping adapter produce a
`ControllerEvent`; apply events with `MixerState::apply`; read deterministic
`output_gains()` and transport/loop state. `Unit` rejects NaN, infinity, out-of-range
values and invalid MIDI bytes. All state changes commit only on success.

**Integration boundary:** no native audio or physical parity has been verified by
this crate. A subsequent adapter must use the official FLX4 channel/CC/note table,
maintain direct sampler event ownership and prevent duplicate hardware events.
The audio engine will consume state on a separate feature flag after its own tests.
