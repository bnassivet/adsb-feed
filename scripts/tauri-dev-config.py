#!/usr/bin/env python3
"""Emit the `tauri dev -c` override that lets a second desktop instance run.

    tauri-dev-config.py <dev_port> <agent_port>

Three keys, merged over tauri.conf.json by the Tauri CLI. Deliberately NOT the
bundle identifier: scoping by identifier would separate the app-data directory
for free, but it changes a build input, so alternating stacks would recompile
and the app would appear twice under ~/Library/Application Support. The app
scopes its own data by ADSB_STACK instead.

The CSP is the half that is easy to miss. `connect-src` in tauri.conf.json names
the agent's port literally, so a second stack's agent on another port is blocked
outright -- with nothing but a console message, which reads as "the agent is
down" rather than "the page was not allowed to ask".

Kept as a file rather than a heredoc inside stack.sh because the JSON is passed
back through a shell argument, and one layer of quoting there was already one
too many.
"""

import json
import sys


def csp(agent_port: str) -> str:
    """The committed CSP with this stack's agent origin substituted in.

    Mirrors `app.security.csp` in tauri.conf.json; if that gains a source, add
    it here too or a second instance loses it.
    """
    return (
        "default-src 'self'; "
        "img-src 'self' https://*.tile.openstreetmap.org "
        "https://*.openstreetmap.org data:; "
        "style-src 'self' 'unsafe-inline' https://unpkg.com; "
        "script-src 'self' 'unsafe-inline'; "
        "connect-src 'self' ipc: http://ipc.localhost "
        "https://*.tile.openstreetmap.org "
        f"http://localhost:{agent_port} http://127.0.0.1:{agent_port}"
    )


def override(dev_port: str, agent_port: str) -> dict:
    return {
        "build": {
            "devUrl": f"http://localhost:{dev_port}",
            # Overridden here rather than by editing package.json, so the
            # committed `npm run dev` stays the plain single-instance path.
            "beforeDevCommand": f"npx next dev --port {dev_port}",
        },
        "app": {"security": {"csp": csp(agent_port)}},
    }


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: tauri-dev-config.py <dev_port> <agent_port>", file=sys.stderr)
        return 2
    print(json.dumps(override(sys.argv[1], sys.argv[2])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
