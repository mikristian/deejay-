"""Public provider bookmarks for the local Music Hub (no streaming extraction)."""
from __future__ import annotations

import json
import hashlib
import os
from pathlib import Path
import re
import tempfile
import threading
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlencode
from urllib.request import Request, build_opener, HTTPRedirectHandler

STATE_PATH = Path(__file__).resolve().parent / '.cache' / 'music_hub_provider_links.json'
_LOCK = threading.RLock()
_SPOTIFY_ID = re.compile(r'^[A-Za-z0-9]{22}$')
_SAFE_PART = re.compile(r'^[A-Za-z0-9_\-]{1,128}$')
_APPLE_ID = re.compile(r'^\d{1,20}$')
_MAX_LINKS = 200


class ProviderError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def parse_link(raw):
    if not isinstance(raw, str) or not 8 <= len(raw) <= 2048:
        raise ProviderError('A valid provider HTTPS URL is required')
    try:
        p = urlsplit(raw.strip())
        hostname = (p.hostname or '').lower()
        if p.scheme.lower() != 'https' or p.username or p.password or p.port or p.fragment or p.netloc.lower() != hostname:
            raise ValueError('Invalid URL authority')
    except ValueError as exc:
        raise ProviderError('Use a direct Spotify, Apple Music, or SoundCloud HTTPS link') from exc
    parts = p.path.strip('/').split('/')
    if any(not part or part in ('.', '..') or '%' in part for part in parts):
        raise ProviderError('Unsupported link path')
    if hostname == 'open.spotify.com':
        if len(parts) == 3 and re.fullmatch(r'intl-[a-z]{2}', parts[0]):
            parts = parts[1:]
        if len(parts) != 2 or parts[0] not in ('playlist', 'track', 'album') or not _SPOTIFY_ID.fullmatch(parts[1]):
            raise ProviderError('Unsupported Spotify playlist, track, or album link')
        provider, kind, external_id = 'spotify', parts[0], parts[1]
        canonical = f'https://open.spotify.com/{kind}/{external_id}'
    elif hostname == 'music.apple.com':
        if len(parts) < 3 or not re.fullmatch(r'[a-z]{2}', parts[0]):
            raise ProviderError('Unsupported Apple Music link')
        country = parts[0]
        if parts[1] == 'playlist' and len(parts) == 4 and _SAFE_PART.fullmatch(parts[2]) and re.fullmatch(r'pl\.[A-Za-z0-9.\-]{1,120}', parts[3]):
            provider, kind, external_id = 'apple_music', 'playlist', parts[3]
            canonical = f'https://music.apple.com/{country}/playlist/{parts[2]}/{external_id}'
        elif parts[1] in ('album', 'song') and len(parts) == 4 and _SAFE_PART.fullmatch(parts[2]) and _APPLE_ID.fullmatch(parts[3]):
            provider, kind, external_id = 'apple_music', parts[1], parts[3]
            canonical = f'https://music.apple.com/{country}/{kind}/{parts[2]}/{external_id}'
        else:
            raise ProviderError('Unsupported Apple Music playlist, song, or album link')
    elif hostname in ('soundcloud.com', 'www.soundcloud.com'):
        if len(parts) not in (2, 3) or not all(_SAFE_PART.fullmatch(x) for x in parts):
            raise ProviderError('Unsupported SoundCloud link')
        if len(parts) == 2 and parts[1] in ('likes', 'sets', 'tracks', 'reposts'):
            raise ProviderError('Private SoundCloud library links require OAuth')
        if len(parts) == 3 and parts[1] == 'sets':
            kind = 'playlist'
        elif len(parts) == 2:
            kind = 'track'
        else:
            raise ProviderError('Unsupported SoundCloud link path')
        provider, external_id = 'soundcloud', '/'.join(parts)
        canonical = 'https://soundcloud.com/' + external_id
    else:
        raise ProviderError('Supported providers: Spotify, Apple Music, SoundCloud')
    return {'provider': provider, 'type': kind, 'externalId': external_id, 'sourceUrl': canonical}


def _read(path):
    if not path.exists():
        return []
    try:
        if path.stat().st_size > 200000:
            raise ValueError('Provider state too large')
        rows = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(rows, list) or len(rows) > _MAX_LINKS or any(not isinstance(x, dict) for x in rows):
            raise ValueError('Malformed provider state')
        return rows
    except (OSError, ValueError) as exc:
        raise ProviderError(f'Provider links unavailable: {exc}', 503) from exc


def _write(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.provider-', suffix='.tmp', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as fp:
            json.dump(rows, fp, ensure_ascii=False, separators=(',', ':'))
            fp.flush()
            os.fsync(fp.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def links(path=STATE_PATH):
    with _LOCK:
        return {'links': _read(Path(path))}


def provider_status():
    from music_hub_spotify import status as spotify_status
    from music_hub_soundcloud import status as soundcloud_status
    spotify = spotify_status()
    soundcloud = soundcloud_status()
    reason = 'Developer OAuth and authorized user access required for private playlists, likes, and library synchronization.'
    return {'providers': {
        'spotify': {'linking': True, 'configured': spotify['configured'], 'connected': spotify['connected'],
                    'privateSync': spotify['connected'], 'account': spotify['account'],
                    'message': 'Spotify authorized read-only metadata access enabled.' if spotify['connected'] else reason},
        'apple_music': {'linking': True, 'configured': False, 'connected': False, 'privateSync': False, 'message': 'MusicKit developer token and authorized Music User Token required for personal library access.'},
        'soundcloud': {'linking': True, 'configured': soundcloud['configured'], 'connected': soundcloud['connected'],
                       'privateSync': soundcloud['connected'], 'account': soundcloud['account'],
                       'message': 'SoundCloud authorized playlist and likes access enabled.' if soundcloud['connected'] else
                                  'Connect through the SoundCloud OAuth 2.1 PKCE flow.' if soundcloud['configured'] else
                                  'Configure an approved SoundCloud developer app to enable account sign-in.'},
    }, 'download': {'enabled': False, 'message': 'Streaming music cannot be downloaded as MP3. SoundCloud creator-authorized downloads require official entitlement and API authorization.'},
    'localFiles': 'Existing user-owned files can be exported through the local Music Hub playlist bridge.'}


_SEARCH_ORIGINS = {
    'spotify': 'https://open.spotify.com/search/',
    'apple_music': 'https://music.apple.com/us/search?term=',
    'soundcloud': 'https://soundcloud.com/search?q=',
}


def _external_search(provider, query):
    from urllib.parse import quote
    encoded = quote(query, safe='')
    return _SEARCH_ORIGINS[provider] + encoded


def setup():
    """Truthful provider connection readiness, with user-directed setup steps."""
    from music_hub_spotify import status as spotify_status
    from music_hub_soundcloud import status as soundcloud_status
    spotify = spotify_status()
    soundcloud = soundcloud_status()
    return {'providers': {
        'spotify': {'configured': spotify['configured'], 'connected': spotify['connected'],
                    'account': spotify['account'], 'authMethod': 'authorization_code_pkce',
                    'clientIdEnvironment': 'MUSIC_HUB_SPOTIFY_CLIENT_ID',
                    'redirectUri': 'http://127.0.0.1:18769/api/music-hub/spotify/callback',
                    'connectEndpoint': '/api/music-hub/spotify/connect' if spotify['configured'] else None,
                    'setupRequired': not spotify['configured'],
                    'message': ('Connected to Spotify.' if spotify['connected'] else
                                'Sign in to Spotify to search its catalog and view permitted metadata.' if spotify['configured'] else
                                'Register a Spotify developer app and set MUSIC_HUB_SPOTIFY_CLIENT_ID; add the exact loopback redirect URI to the app settings.')},
        'apple_music': {'configured': False, 'connected': False,
                        'authMethod': 'musickit_user_authorization', 'connectEndpoint': None,
                        'setupRequired': True,
                        'message': 'Apple Music account sign-in requires a signed MusicKit developer token and Music User Token authorization; this local Music Hub does not offer that flow yet. The existing Mac Music local-library bridge remains separate.'},
        'soundcloud': {'configured': soundcloud['configured'], 'connected': soundcloud['connected'],
                       'authMethod': 'oauth2_authorization_code_pkce', 'connectEndpoint': '/api/music-hub/soundcloud/connect' if soundcloud['configured'] else None,
                       'setupRequired': not soundcloud['configured'],
                       'clientIdEnvironment': 'MUSIC_HUB_SOUNDCLOUD_CLIENT_ID',
                       'clientSecretEnvironment': 'MUSIC_HUB_SOUNDCLOUD_CLIENT_SECRET',
                       'redirectUri': 'http://127.0.0.1:18769/api/music-hub/soundcloud/callback',
                       'message': 'Connected to SoundCloud.' if soundcloud['connected'] else
                                  'Sign in through SoundCloud to view your authorized playlists and likes.' if soundcloud['configured'] else
                                  'SoundCloud sign-in requires an approved developer app with OAuth PKCE. Set MUSIC_HUB_SOUNDCLOUD_CLIENT_ID and MUSIC_HUB_SOUNDCLOUD_CLIENT_SECRET on the local server, and register the exact callback URI.'},
    }, 'redirectSafety': 'Local callback, short-lived state, PKCE S256, macOS Keychain refresh tokens',
    'downloadAvailable': False}


def search(query, provider):
    """Perform permitted provider search, or return a direct official web search URL."""
    if provider not in _SEARCH_ORIGINS:
        raise ProviderError('Choose Spotify, Apple Music, or SoundCloud')
    if not isinstance(query, str) or not 1 <= len(query.strip()) <= 150:
        raise ProviderError('Search must contain 1–150 characters')
    query = query.strip()
    fallback = _external_search(provider, query)
    if provider == 'spotify':
        from music_hub_spotify import SpotifyError, search as spotify_search, status
        if status()['connected']:
            try:
                return {**spotify_search(query), 'externalSearchUrl': fallback}
            except SpotifyError as exc:
                # An API/authentication failure must be explicit, not treated as a successful empty result.
                return {'provider': provider, 'source': 'external_link', 'items': [],
                        'externalSearchUrl': fallback, 'apiError': str(exc),
                        'setupRequired': exc.status == 401, 'downloadAvailable': False}
    return {'provider': provider, 'source': 'external_link', 'items': [],
            'externalSearchUrl': fallback,
            'setupRequired': provider != 'spotify' or not setup()['providers']['spotify']['configured'],
            'message': ('Connect Spotify to search through its official API.' if provider == 'spotify' else
                        'Open official provider search; in-app provider authorization is not set up.'),
            'downloadAvailable': False}


def _metadata(item, fetch=None):
    """Optional bounded public metadata via official provider oEmbed; never follow redirects."""
    if item['provider'] == 'apple_music':
        return None
    endpoint = ('https://open.spotify.com/oembed' if item['provider'] == 'spotify'
                else 'https://soundcloud.com/oembed')
    target = endpoint + '?' + urlencode({'url': item['sourceUrl'], 'format': 'json'})
    if fetch is None:
        return None  # Public metadata is opt-in; no unexpected outgoing network traffic.
    try:
        data = fetch(target)
        if not isinstance(data, dict):
            return None
        title = data.get('title')
        if isinstance(title, str) and title.strip():
            return {'title': title.strip()[:200]}
    except (OSError, ValueError, TimeoutError):
        pass
    return None


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _official_oembed(url):
    """Fetch public metadata from a fixed official HTTPS endpoint only."""
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname not in ('open.spotify.com', 'soundcloud.com'):
        raise ValueError('Metadata endpoint is not allowlisted')
    opener = build_opener(_NoRedirect)
    request = Request(url, headers={'Accept': 'application/json', 'User-Agent': 'LocalMusicHub/1.0'})
    with opener.open(request, timeout=3) as reply:
        if reply.status != 200 or int(reply.headers.get('Content-Length', '0') or '0') > 32768:
            raise ValueError('Invalid metadata response')
        data = reply.read(32769)
    if len(data) > 32768:
        raise ValueError('Metadata response too large')
    return json.loads(data.decode('utf-8'))


def mutate(payload, path=STATE_PATH, fetch=None):
    if not isinstance(payload, dict):
        raise ProviderError('JSON object required')
    action = payload.get('action', 'link')
    if action not in ('link', 'unlink', 'refresh'):
        raise ProviderError('Action must be link, unlink, or refresh')
    with _LOCK:
        path = Path(path)
        rows = _read(path)
        item = None
        if action == 'link':
            normalized = parse_link(payload.get('url'))
            item = next((x for x in rows if x.get('sourceUrl') == normalized['sourceUrl']), None)
            if item is None:
                if len(rows) >= _MAX_LINKS:
                    raise ProviderError('Maximum saved provider links reached', 413)
                stable_id = hashlib.sha256(normalized['sourceUrl'].encode('utf-8')).hexdigest()[:24]
                item = {'id': normalized['provider'] + ':' + stable_id, **normalized,
                        'title': normalized['externalId'], 'status': 'linked_unverified', 'lastVerified': None,
                        'tracks': [], 'localMatches': []}
                rows.append(item)
        else:
            identifier = payload.get('id')
            if not isinstance(identifier, str) or len(identifier) > 256:
                raise ProviderError('Valid link id required')
            item = next((x for x in rows if x.get('id') == identifier), None)
            if item is None:
                raise ProviderError('Saved link not found', 404)
            if action == 'unlink':
                rows.remove(item)
                _write(path, rows)
                return {'links': rows, 'removedId': identifier}
        info = _metadata(item, fetch=(fetch if fetch is not None else _official_oembed)
                         if action == 'refresh' else None)
        if info:
            item.update(info)
            item['status'] = 'public_metadata_verified'
            item['lastVerified'] = datetime.now(timezone.utc).isoformat()
        else:
            item['status'] = 'linked_unverified' if item['lastVerified'] is None else item['status']
        _write(path, rows)
        return {'links': rows, 'link': item}
