# Music Hub

A local DJ library and performance-planning workspace with a web frontend, Python service components, optional Rust audio modules, and a macOS Swift wrapper.

Music Hub is a **source release for developers**. The UI and its static code can be inspected independently, while music-library integration, installed-app parity and physical controller feedback still require local setup and further verification.

## What is in the source

| Area | Source | Functionality and scope |
| --- | --- | --- |
| Music library | `music-hub/index.html`, `app.js`, `styles.css` | Search, filtering, track lists, playlists, next-up queue, library-health inspection and metadata-based track management. |
| DJ preparation | `harmonic-order.js`, `local-automix.js`, `top-decks-waveform.js`, `performance-chrome.js` | Harmonic ordering, set-list planning, waveform presentation and read-only performance feedback surfaces. These do not establish physical playback control. |
| Instruments and editing | `sampler.js`, `additional-instruments.js`, `stems.js`, `studio.js` | Sampler/stems/studio user interfaces and their associated integration hooks. Compute services and local audio are optional. |
| Connected services | `provider-discovery.js`, `connection-settings.js`, `backend/` | Local backend and service metadata/connectors; authentication and local services must be configured by the developer. |
| Mobile and desktop | `mobile.html`, `mobile.js`, `desktop-remote.js`, `native/MusicHub.swift` | Companion interface, remote-related source, and macOS web-wrapper source. |
| Audio core | `rust/music-hub-core/`, `rust/music-hub-audio/` | Optional Rust crates, requiring a Rust toolchain and platform audio support. |
| Checks | `tests/`, `music-hub/*.test.cjs` | UI/contracts and service tests, including tests that require local integration fixtures. |

## Browse the interface

Open `music-hub/index.html` in a modern browser or serve the directory over localhost, for example:

```sh
cd music-hub
python3 -m http.server 8080
# http://127.0.0.1:8080/
```

The interface may load in disconnected mode; live library lists, accounts, audio and performance feedback require the corresponding local services. The Swift wrapper is configured for a Python server on `127.0.0.1:18769`; inspect `backend/runtime_server.py` and `backend/requirements.txt` before configuring your own machine. Do not assume the wrapper can be packaged directly from this export.

## Developer validation

From this repository root:

```sh
node --check music-hub/app.js
node --check music-hub/sampler.js
node --check music-hub/native-rust-audio.js
node --test music-hub/native-rust-audio.contract.test.cjs
# Optional, if Cargo is available:
cargo test --manifest-path rust/music-hub-core/Cargo.toml
```

Python service tests have environmental prerequisites. See [STATUS.md](STATUS.md) for the staged audit results and known failing tests; a passing frontend syntax check does **not** prove a complete DJ/audio workflow.

## Current limits

- The published source has not been proven to reproduce the currently installed Music Hub app end-to-end.
- External streaming subscriptions are accessed through provider-approved APIs and user accounts; the code does not bundle their audio.
- Rekordbox library paths, hardware routing, live deck events, stem computation, plugin-dependent audio, and native packaging must be configured and independently verified.
- No personal music library, audio, stems, media cache, Rekordbox database, provider tokens, or compiled application is included.

See [third-party notices](THIRD_PARTY_NOTICES.md) for external components and attribution. This project is not affiliated with AlphaTheta, Pioneer DJ, or any music provider.

## UI preview

![Music Hub local browser preview with empty library and unverified decks](docs/screenshots/music-hub-disconnected.png)

*Actual browser capture of the staged HTML in a disconnected local preview, 2026-11-14. No songs, user playlists, live hardware status or backend connection are demonstrated. On-screen bridge labels are UI state only and are not proof of a connected controller.*
