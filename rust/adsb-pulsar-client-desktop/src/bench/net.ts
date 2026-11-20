/**
 * Network profiles for the bench's tile server (`npm run bench -- --net dsl`).
 * Pure, so the Node driver and the tests share it. Applied to `/fixtures/`
 * tiles only: the page's own code is not what a gesture waits for.
 *
 * A profile is a fixed latency per request plus ONE link of limited bandwidth
 * that every response queues on, which is what makes many tiles requested at
 * once arrive one after another, as over a real connection.
 */
export interface NetProfile {
  /** Added before each response starts (round trip + server time). */
  latencyMs: number;
  /** Shared downstream bandwidth; null = unlimited. */
  mbps: number | null;
}

export const NET_PROFILES = {
  local: { latencyMs: 0, mbps: null },
  broadband: { latencyMs: 30, mbps: 50 },
  dsl: { latencyMs: 60, mbps: 8 },
  mobile: { latencyMs: 150, mbps: 2 },
} as const satisfies Record<string, NetProfile>;

export type NetName = keyof typeof NET_PROFILES;

export function parseNet(name: string): NetProfile {
  if (!(name in NET_PROFILES)) throw new Error(`unknown net profile "${name}" (known: ${Object.keys(NET_PROFILES).join(", ")})`);
  return NET_PROFILES[name as NetName];
}

/**
 * One bottleneck link: responses are sent first come, first served.
 * Written without parameter properties: Node imports this file with type
 * stripping only, which rejects them.
 */
export class Link {
  private freeAt = 0;
  private readonly mbps: number | null;

  constructor(mbps: number | null) {
    this.mbps = mbps;
  }

  /** Reserve the link for `bytes` from `now` (ms); returns when the last byte has arrived. */
  reserve(now: number, bytes: number): number {
    if (this.mbps === null) return now;
    const start = Math.max(now, this.freeAt);
    this.freeAt = start + (bytes * 8) / (this.mbps * 1000);
    return this.freeAt;
  }
}
