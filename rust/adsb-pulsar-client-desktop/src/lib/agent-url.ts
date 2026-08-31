/**
 * Base URL of the Python agent service (`adsb-agent`).
 *
 * One definition, because three call sites used to hardcode
 * `http://localhost:8000` independently. With two desktop instances running
 * against two stacks, a hardcoded port means the second window's chat and voice
 * silently query the *first* stack's data -- the exact cross-mix that per-stack
 * storage exists to prevent.
 *
 * `NEXT_PUBLIC_AGENT_URL` is read by the dev server at start-up, which is when
 * `scripts/stack.sh` sets it. Note it is baked in at `next build` time, so a
 * bundled production app keeps whatever it was built with: running several
 * stacks side by side is a development affordance, not a shipped feature.
 *
 * The app's CSP must also allow this origin (`connect-src` in
 * `tauri.conf.json`), or requests fail with nothing but a console message.
 * `stack.sh` overrides that per instance via `tauri dev -c`.
 */
export const AGENT_BASE_URL =
  process.env.NEXT_PUBLIC_AGENT_URL ?? "http://localhost:8000";

/** AG-UI transport endpoint the CopilotKit provider talks to. */
export const AGENT_AG_UI_URL = `${AGENT_BASE_URL}/ag-ui`;
