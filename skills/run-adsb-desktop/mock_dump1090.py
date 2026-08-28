#!/usr/bin/env python3
"""Mock dump1090 SBS-1 feed on :30003 for verifying the desktop app.

Emits a handful of aircraft orbiting the configured receiver location,
interleaving MSG3 (position), MSG1 (callsign) and MSG4 (speed) so the
ingest pipeline's per-aircraft merge is actually exercised -- a MSG1
arriving after a MSG3 in the same 500ms flush window must not erase the
position. Hex idents are deliberately fake and greppable.
"""
import math, socket, threading, time
from datetime import datetime

HOST, PORT = "127.0.0.1", 30003
RX_LAT, RX_LON = 46.717915, -2.33716964

AIRCRAFT = [
    # hex,    callsign,   radius_nm, bearing0, alt,   speed, squawk
    ("TST001", "CLAUDE1", 0.15, 0,   35000, 450, "1000"),
    ("TST002", "CLAUDE2", 0.25, 60,  28000, 410, "2000"),
    ("TST003", "CLAUDE3", 0.10, 120, 12000, 280, "3000"),
    ("TST004", "CLAUDE4", 0.30, 200, 39000, 480, "4000"),
    ("TST005", "CLAUDE5", 0.20, 280, 22000, 350, "5000"),
    ("TST006", "CLAUDE6", 0.35, 330,  8000, 210, "6000"),
]

def ts():
    n = datetime.now()
    return n.strftime("%Y/%m/%d"), n.strftime("%H:%M:%S.") + f"{n.microsecond // 1000:03d}"

def msg(tt, hexid, fields):
    d, t = ts()
    row = ["MSG", str(tt), "1", "1", hexid, "1", d, t, d, t] + fields
    return ",".join(row) + "\r\n"

def serve(conn):
    print(f"[mock] client connected", flush=True)
    step = 0
    try:
        while True:
            for i, (hexid, cs, rad, brg0, alt, spd, sqk) in enumerate(AIRCRAFT):
                ang = math.radians(brg0 + step * 2.0 + i * 7)
                lat = RX_LAT + rad * math.cos(ang)
                lon = RX_LON + rad * math.sin(ang) / math.cos(math.radians(RX_LAT))
                trk = (brg0 + step * 2.0 + 90) % 360

                # MSG3: position (altitude, lat, lon)
                conn.sendall(msg(3, hexid, ["", str(alt), "", "", f"{lat:.5f}", f"{lon:.5f}", "", "", "0", "0", "0", "0"]).encode())
                # MSG1: callsign only -- must NOT erase the position above
                conn.sendall(msg(1, hexid, [cs, "", "", "", "", "", "", "", "0", "0", "0", "0"]).encode())
                # MSG4: speed/track/vertical rate
                conn.sendall(msg(4, hexid, ["", "", str(spd), f"{trk:.1f}", "", "", "64", "", "0", "0", "0", "0"]).encode())

            # dump1090 heartbeat
            conn.sendall(msg(8, "000000", ["", "", "", "", "", "", "", "", "0", "0", "0", "0"]).encode())
            step += 1
            if step % 10 == 0:
                print(f"[mock] {step} cycles, {step * len(AIRCRAFT) * 3} msgs sent", flush=True)
            time.sleep(1.0)
    except (BrokenPipeError, ConnectionResetError):
        print("[mock] client disconnected", flush=True)

srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind((HOST, PORT))
srv.listen(5)
print(f"[mock] listening on {HOST}:{PORT}", flush=True)
while True:
    c, _ = srv.accept()
    threading.Thread(target=serve, args=(c,), daemon=True).start()
