/** Statistics and reporting for the map render benchmark. Pure: shared by the page and the Node driver. */

export const BASELINE = "leaflet";
export const VARIANTS = ["leaflet", "deckgl", "maplibre", "openlayers"] as const;
export type Variant = (typeof VARIANTS)[number];
export type Scenario = "initial" | "panzoom" | "settle" | "live" | "memory";
export type Style = "dots" | "line";

/** One repetition of one scenario on one variant. `dnf` = timed out or crashed. */
export interface RunResult {
  variant: string;
  engine: string;
  size: number;
  style: Style;
  scenario: Scenario;
  rep: number;
  dnf: boolean;
  metrics: Record<string, number>;
  error?: string;
}

export interface AggregateRow {
  variant: string;
  engine: string;
  size: number;
  style: Style;
  scenario: Scenario;
  reps: number;
  dnfCount: number;
  /** True only when every repetition failed. */
  dnf: boolean;
  metrics: Record<string, number | null>;
  /** metric / baseline metric; null when either side has no value. */
  ratio: Record<string, number | null>;
}

/** Linear interpolation between closest ranks (numpy's default). */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = ((s.length - 1) * p) / 100;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function median(xs: readonly number[]): number {
  return percentile(xs, 50);
}

/** One 60 Hz vsync, with slack so a frame that is exactly on time is not "slow". */
const SLOW_MS = 16.7;
const JANK_MS = 50;

export interface FrameSummary {
  frames: number;
  p50: number;
  p95: number;
  max: number;
  over16Pct: number;
  over50Pct: number;
}

export function summarizeFrames(deltas: readonly number[]): FrameSummary {
  const n = deltas.length;
  const slow = deltas.filter((d) => d > SLOW_MS).length;
  const jank = deltas.filter((d) => d > JANK_MS).length;
  return {
    frames: n,
    p50: percentile(deltas, 50),
    p95: percentile(deltas, 95),
    max: n ? Math.max(...deltas) : NaN,
    over16Pct: n ? (100 * slow) / n : NaN,
    over50Pct: n ? (100 * jank) / n : NaN,
  };
}

function variantOrder(v: string): number {
  const i = (VARIANTS as readonly string[]).indexOf(v);
  return i === -1 ? VARIANTS.length : i;
}

/** Median per (engine, size, style, scenario, variant), with ratios against the baseline. */
export function aggregate(results: readonly RunResult[], baseline: string = BASELINE): AggregateRow[] {
  const groups = new Map<string, RunResult[]>();
  for (const r of results) {
    const key = [r.engine, r.size, r.style, r.scenario, r.variant].join("|");
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(r);
  }

  const rows: AggregateRow[] = [];
  for (const g of groups.values()) {
    const ok = g.filter((r) => !r.dnf);
    const keys = new Set(ok.flatMap((r) => Object.keys(r.metrics)));
    const metrics: Record<string, number | null> = {};
    for (const k of keys) {
      const vals = ok.map((r) => r.metrics[k]).filter((v) => v !== undefined && Number.isFinite(v));
      metrics[k] = vals.length ? median(vals) : null;
    }
    const { variant, engine, size, style, scenario } = g[0];
    rows.push({
      variant, engine, size, style, scenario,
      reps: g.length,
      dnfCount: g.length - ok.length,
      dnf: ok.length === 0,
      metrics,
      ratio: {},
    });
  }

  const sameGroup = (a: AggregateRow, b: AggregateRow) =>
    a.engine === b.engine && a.size === b.size && a.style === b.style && a.scenario === b.scenario;
  for (const row of rows) {
    const base = rows.find((b) => b.variant === baseline && sameGroup(b, row));
    // A variant that never finished still reports every metric its peers have, as null.
    const keys = new Set(rows.filter((o) => sameGroup(o, row)).flatMap((o) => Object.keys(o.metrics)));
    for (const k of keys) {
      if (!(k in row.metrics)) row.metrics[k] = null;
      const v = row.metrics[k];
      const b = base?.metrics[k] ?? null;
      row.ratio[k] = v === null || b === null || b === 0 ? null : v / b;
    }
  }

  return rows.sort(
    (a, b) =>
      a.engine.localeCompare(b.engine) ||
      a.scenario.localeCompare(b.scenario) ||
      a.style.localeCompare(b.style) ||
      a.size - b.size ||
      variantOrder(a.variant) - variantOrder(b.variant),
  );
}

/** The one number each scenario's table shows. Full metrics stay in the JSON. */
export const PRIMARY_METRIC: Record<Scenario, { key: string; unit: string; label: string }> = {
  initial: { key: "totalMs", unit: "ms", label: "time to first rendered frame" },
  panzoom: { key: "p95", unit: "ms", label: "p95 frame time while panning/zooming" },
  settle: { key: "settleMs", unit: "ms", label: "moveend → next painted frame (median of stops)" },
  live: { key: "p95", unit: "ms", label: "p95 frame time with 500 aircraft updating every 500 ms" },
  memory: { key: "heapMB", unit: "MB", label: "JS heap after GC (Chromium only)" },
};

export function sizeLabel(n: number): string {
  if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (n >= 1_000 && n % 1_000 === 0) return `${n / 1_000}k`;
  return String(n);
}

function cell(row: AggregateRow | undefined, key: string, unit: string): string {
  if (!row) return "–";
  if (row.dnf) return "DNF";
  const v = row.metrics[key];
  if (v === null || v === undefined) return "–";
  let s = `${v.toFixed(1)} ${unit}`;
  const r = row.ratio[key];
  if (row.variant !== BASELINE && r !== null && r !== undefined) s += ` (×${r.toFixed(2)})`;
  if (row.dnfCount > 0) s += ` ⚠${row.dnfCount}`;
  return s;
}

export function toMarkdown(rows: readonly AggregateRow[]): string {
  const tables = new Map<string, AggregateRow[]>();
  for (const r of rows) {
    const key = `${r.engine} · ${r.scenario} · ${r.style}`;
    let t = tables.get(key);
    if (!t) tables.set(key, (t = []));
    t.push(r);
  }

  const out: string[] = [];
  for (const [title, t] of tables) {
    const { key, unit, label } = PRIMARY_METRIC[t[0].scenario];
    const sizes = [...new Set(t.map((r) => r.size))].sort((a, b) => a - b);
    const variants = [...new Set(t.map((r) => r.variant))].sort((a, b) => variantOrder(a) - variantOrder(b));
    out.push(`### ${title}`, "", `_${label}; lower is better; ×n = ratio to ${BASELINE}_`, "");
    out.push(`| Variant | ${sizes.map(sizeLabel).join(" | ")} |`);
    out.push(`|---|${sizes.map(() => "---:").join("|")}|`);
    for (const v of variants) {
      const cells = sizes.map((s) => cell(t.find((r) => r.variant === v && r.size === s), key, unit));
      out.push(`| ${v} | ${cells.join(" | ")} |`);
    }
    out.push("");
  }
  return out.join("\n");
}
