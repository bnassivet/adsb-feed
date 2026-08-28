#!/usr/bin/env python3
"""Print the mock aircraft found in a getAircraftSummary response (stdin)."""
import json
import sys

rows = [a for a in (json.load(sys.stdin).get("data") or [])
        if a["hex_ident"].startswith("TST")]
print(f"mock aircraft: {len(rows)}")
for a in sorted(rows, key=lambda x: x["hex_ident"]):
    print(f"  {a['hex_ident']}  {a['callsign']:<8} "
          f"alt={a['max_altitude']:>7.0f}  positions={a['position_count']}")
sys.exit(0 if len(rows) == 6 else 1)
