#!/usr/bin/env python3
"""Assert the ingest pipeline merged all three SBS-1 subtypes onto one record.

Reads a getTrajectory response on stdin. The mock feed interleaves MSG3
(position), MSG1 (callsign) and MSG4 (speed/track) for each aircraft inside a
single 500ms flush window, so a correct `merge_into_buffer` puts all three on
one row. A regression shows up as `latitude: None` -- MSG1's nulls having
overwritten the fix MSG3 established.
"""
import json
import sys

pts = json.load(sys.stdin).get("data") or []
if not pts:
    print("FAIL: no trajectory returned for TST001")
    sys.exit(1)

p = pts[0]
checks = {
    "position (from MSG3)": p.get("latitude") is not None and p.get("longitude") is not None,
    "callsign (from MSG1)": p.get("callsign") is not None,
    "speed+track (from MSG4)": p.get("ground_speed") is not None and p.get("track") is not None,
}

for label, ok in checks.items():
    print(f"  {'PASS' if ok else 'FAIL'}  {label}")

print(f"  trajectory points: {len(pts)}")
print(
    "  sample: lat={latitude} lon={longitude} callsign={callsign} "
    "alt={altitude} gs={ground_speed} trk={track}".format(**{
        k: p.get(k) for k in
        ("latitude", "longitude", "callsign", "altitude", "ground_speed", "track")
    })
)

sys.exit(0 if all(checks.values()) else 1)
