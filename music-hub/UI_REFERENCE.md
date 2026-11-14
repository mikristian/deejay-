# Music Hub mobile UI reference

The mobile companion's Spotify-inspired navigation, near-black visual treatment,
compact playlist cards and traditional song-list hierarchy were based on the
public screenshots and structure in
[Franco Borrelli's Spotify React Web Client](https://github.com/francoborrelli/spotify-react-web-client),
published under the MIT license (Copyright © 2018 Franco Martín Borrelli).

This project keeps its existing lightweight local-library client and authenticated
Music Hub bridge, rather than incorporating Spotify OAuth, Spotify Web Playback
SDK, Spotify branding or bundled licensed album artwork. The original app
is not installed or used as the Music Hub playback engine.

Music Hub-specific features include an always-visible two-deck waveform strip
drawn from locally analyzed Rekordbox amplitude values, playlist track rows,
swipe-to-Deck-A/B intentions, and capability-gated local laptop staging.
The phone is not an authenticated controller of native Rekordbox transport.
