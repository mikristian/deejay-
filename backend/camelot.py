CAMELOT_WHEEL = {
    "1A": "Ab minor", "1B": "B major",
    "2A": "Eb minor", "2B": "F# major",
    "3A": "Bb minor", "3B": "Db major",
    "4A": "F minor", "4B": "Ab major",
    "5A": "C minor", "5B": "Eb major",
    "6A": "G minor", "6B": "Bb major",
    "7A": "D minor", "7B": "F major",
    "8A": "A minor", "8B": "C major",
    "9A": "E minor", "9B": "G major",
    "10A": "B minor", "10B": "D major",
    "11A": "F# minor", "11B": "A major",
    "12A": "Db minor", "12B": "E major",
}

def normalize_key(camelot_key: str) -> str:
    key = str(camelot_key).strip().upper()
    if key not in CAMELOT_WHEEL:
        raise ValueError(f"invalid Camelot key: {camelot_key!r}")
    return key

def _parse(camelot_key: str):
    key = normalize_key(camelot_key)
    return int(key[:-1]), key[-1]

def compatible_keys(camelot_key: str):
    num, letter = _parse(camelot_key)
    other_letter = "B" if letter == "A" else "A"
    prev_num = 12 if num == 1 else num - 1
    next_num = 1 if num == 12 else num + 1
    return {f"{num}{letter}", f"{num}{other_letter}", f"{prev_num}{letter}", f"{next_num}{letter}"}

def rank_candidates(current_key: str, current_bpm: float, tracks: list, bpm_tolerance: float = 0.06):
    current_key = normalize_key(current_key)
    current_bpm = float(current_bpm)
    if current_bpm <= 0:
        raise ValueError("current_bpm must be greater than 0")
    if not 0 <= bpm_tolerance <= 0.5:
        raise ValueError("bpm_tolerance must be between 0 and 0.5")

    compatible = compatible_keys(current_key)
    ranked = []
    for index, raw in enumerate(tracks):
        track = dict(raw)
        raw_key = str(track.get("key", "")).strip().upper()
        key_ok = raw_key in compatible
        bpm = float(track.get("bpm") or 0)
        delta = abs(bpm - current_bpm) / current_bpm if bpm > 0 else 999.0
        bpm_ok = delta <= bpm_tolerance
        bucket = 0 if key_ok and bpm_ok else 1 if key_ok else 2 if bpm_ok else 3
        track["_mix"] = {
            "harmonic_match": key_ok,
            "bpm_match": bpm_ok,
            "bpm_delta_percent": round(delta * 100, 2) if bpm > 0 else None,
            "rank_bucket": bucket,
        }
        ranked.append((bucket, delta, index, track))
    ranked.sort(key=lambda item: (item[0], item[1], item[2]))
    return [item[3] for item in ranked]
