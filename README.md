# Music Hub — source publication candidate

Music Hub is a local web interface for DJ library browsing, deck controls, playlists, stems, sampling, and optional Rust audio components. The macOS Swift wrapper points at a separate local Python server on 127.0.0.1:18769. External applications, controller routing, and online providers require independent setup.

## Contents
- `music-hub/`: HTML/CSS/JS frontend, source-only Swift wrapper.
- `backend/`: selected Python runtime modules; requires configuration and other locally installed integrations.
- `rust/`: Rust audio/core crate manifests and source.
- `tests/`: selected test source and contract checks.

## Verify
`node --check music-hub/app.js`, `node --check music-hub/sampler.js`, and `node --test music-hub/native-rust-audio.contract.test.cjs`. Rust: `cargo test --manifest-path rust/music-hub-core/Cargo.toml` where Rust is available. Python server integration requires dependencies from `backend/requirements.txt` plus runtime components and local music providers.

## Limits
Not a self-contained installer. Frontend/backend parity with the currently installed wrapper has not been established end-to-end. Controller/audio routing, paid streaming APIs, stems compute services and native features depend on configured local hardware/software. No users' tracks, cache, Rekordbox database, stem files, or binaries are included.
