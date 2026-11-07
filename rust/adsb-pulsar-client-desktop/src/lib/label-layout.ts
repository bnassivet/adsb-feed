/**
 * Track label text and automatic placement — pure, no Leaflet.
 *
 * Each live aircraft gets a label `HEX/CALLSIGN` placed in one of 16 candidate
 * slots around its icon (8 compass directions × 2 rings). Slots are scored so a
 * label sits *beside* its aircraft and away from the trail behind it, with a
 * bonus for keeping last frame's slot (labels would otherwise jump at the feed's
 * 2 Hz refresh). Placement is greedy in priority order; a label whose every slot
 * collides with an already-placed label, another aircraft's icon or the viewport
 * edge is hidden — the only way to guarantee no overlap in dense traffic.
 *
 * All coordinates are container pixels (`map.latLngToContainerPoint`).
 */

/** Monospace 10px: every glyph is the same width, so box sizes need no DOM measuring. */
export const LABEL_CHAR_WIDTH = 6;
export const LABEL_PADDING_X = 4;
export const LABEL_HEIGHT = 14;
export const CANDIDATES_PER_RING = 8;

/** Matches `aircraftIconHtml`: 24px, or 36px when selected. */
const ICON_HALF = 12;
const ICON_HALF_SELECTED = 18;
const INNER_GAP = 4;
const OUTER_RING_EXTRA = 24;

const OUTER_RING_COST = 60;
const LEFT_SIDE_COST = 5;
const PREVIOUS_SLOT_BONUS = 40;

export interface LabelItem {
  key: string;
  /** Aircraft position, container pixels. */
  x: number;
  y: number;
  /** Track over ground in degrees clockwise from north, or null if unknown. */
  heading: number | null;
  text: string;
  selected: boolean;
  /** Higher is placed first (after selected tracks). Typically `last_seen`. */
  priority: number;
}

export interface LabelPlacement {
  /** 0..7 inner ring, 8..15 outer ring; direction = `candidateAngle(candidate)`. */
  candidate: number;
  /** Label box, container pixels. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Box top-left relative to the aircraft. */
  dx: number;
  dy: number;
  /** True on the outer ring, where a leader line joins the label to its aircraft. */
  leader: boolean;
  /** Leader end point (nearest point of the box) relative to the aircraft. */
  lx: number;
  ly: number;
}

export interface Viewport {
  width: number;
  height: number;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function formatTrackLabel(t: { hex_ident: string; callsign: string | null }): string {
  const callsign = t.callsign?.trim();
  return `${t.hex_ident}/${callsign ? callsign : "-"}`;
}

export function labelSize(text: string): { width: number; height: number } {
  return { width: text.length * LABEL_CHAR_WIDTH + 2 * LABEL_PADDING_X, height: LABEL_HEIGHT };
}

/** Compass bearing of a candidate slot: 0 = N, 45 = NE, … 315 = NW. */
export function candidateAngle(candidate: number): number {
  return (candidate % CANDIDATES_PER_RING) * (360 / CANDIDATES_PER_RING);
}

function angleDiff(a: number, b: number): number {
  const d = (((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

/** Lower is better. */
function candidateCost(candidate: number, heading: number | null): number {
  const angle = candidateAngle(candidate);
  const ring = candidate >= CANDIDATES_PER_RING ? OUTER_RING_COST : 0;
  if (heading === null) {
    // No trail direction to avoid: prefer east, then fan out.
    return ring + angleDiff(angle, 90) / 10;
  }
  // d = 0 on the trail, 90 beside the aircraft, 180 straight ahead.
  const d = angleDiff(angle, heading + 180);
  const trailPenalty = Math.max(0, 90 - d);
  const rel = (((angle - heading) % 360) + 360) % 360;
  const side = rel > 0 && rel < 180 ? 0 : LEFT_SIDE_COST;
  return ring + Math.abs(d - 90) + trailPenalty + side;
}

function slotBox(item: LabelItem, candidate: number, width: number, height: number) {
  const outer = candidate >= CANDIDATES_PER_RING;
  const half = item.selected ? ICON_HALF_SELECTED : ICON_HALF;
  const radius = half + INNER_GAP + (outer ? OUTER_RING_EXTRA : 0);
  const rad = (candidateAngle(candidate) * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  // Anchor point on a *square* ring — the icon is square, and a circular ring
  // would put a diagonal slot's corner (r·0.707) inside it. The box hangs off
  // the anchor on the side facing away from the aircraft.
  const clamp = (v: number) => Math.max(-1, Math.min(1, v * Math.SQRT2));
  const ax = radius * clamp(sin);
  const ay = -radius * clamp(cos);
  const dx = Math.round(sin > 0.3 ? ax : sin < -0.3 ? ax - width : ax - width / 2);
  const dy = Math.round(cos > 0.3 ? ay - height : cos < -0.3 ? ay : ay - height / 2);
  const lx = Math.min(Math.max(0, dx), dx + width);
  const ly = Math.min(Math.max(0, dy), dy + height);
  return { dx, dy, lx, ly, leader: outer };
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function iconBox(item: LabelItem): Box {
  const half = item.selected ? ICON_HALF_SELECTED : ICON_HALF;
  return { left: item.x - half, top: item.y - half, right: item.x + half, bottom: item.y + half };
}

function inside(b: Box, view: Viewport): boolean {
  return b.left >= 0 && b.top >= 0 && b.right <= view.width && b.bottom <= view.height;
}

/** Grid cell edge, px. About a label's height × 3: a typical label spans 2–3 cells. */
const GRID_CELL = 48;

/** An obstacle: an aircraft icon (owner = its key) or a placed label (owner = ""). */
interface Obstacle {
  box: Box;
  owner: string;
}

/**
 * Uniform grid over the viewport. Each obstacle is filed under every cell it
 * touches, so a query only looks at its neighbours. A full scan made layout
 * quadratic (37 ms at 1,000 aircraft); this keeps it close to linear.
 */
class ObstacleGrid {
  private readonly cols: number;
  private readonly rows: number;
  private readonly cells: Obstacle[][];

  constructor(view: Viewport) {
    this.cols = Math.max(1, Math.ceil(view.width / GRID_CELL));
    this.rows = Math.max(1, Math.ceil(view.height / GRID_CELL));
    this.cells = Array.from({ length: this.cols * this.rows }, () => []);
  }

  private span(b: Box): [number, number, number, number] {
    const c0 = Math.max(0, Math.floor(b.left / GRID_CELL));
    const r0 = Math.max(0, Math.floor(b.top / GRID_CELL));
    const c1 = Math.min(this.cols - 1, Math.floor(b.right / GRID_CELL));
    const r1 = Math.min(this.rows - 1, Math.floor(b.bottom / GRID_CELL));
    return [c0, r0, c1, r1];
  }

  add(o: Obstacle): void {
    const [c0, r0, c1, r1] = this.span(o.box);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) this.cells[r * this.cols + c].push(o);
    }
  }

  /** True if `b` overlaps any obstacle not owned by `self`. */
  collides(b: Box, self: string): boolean {
    const [c0, r0, c1, r1] = this.span(b);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        for (const o of this.cells[r * this.cols + c]) {
          if (o.owner !== self && overlaps(o.box, b)) return true;
        }
      }
    }
    return false;
  }
}

/**
 * Places every item's label, or `null` when it cannot be placed without overlap.
 * `previous` is last frame's result; a slot that is still free is kept.
 */
export function layoutLabels(
  items: readonly LabelItem[],
  view: Viewport,
  previous?: ReadonlyMap<string, LabelPlacement | null>,
): Map<string, LabelPlacement | null> {
  const result = new Map<string, LabelPlacement | null>();
  const grid = new ObstacleGrid(view);
  const viewBox: Box = { left: 0, top: 0, right: view.width, bottom: view.height };
  for (const i of items) {
    const box = iconBox(i);
    // Labels never leave the viewport, so an icon outside it can never block one.
    if (overlaps(box, viewBox)) grid.add({ box, owner: i.key });
  }

  const order = [...items].sort((a, b) => {
    if (a.selected !== b.selected) return a.selected ? -1 : 1;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  const total = CANDIDATES_PER_RING * 2;

  for (const item of order) {
    const onScreen = item.x >= 0 && item.y >= 0 && item.x <= view.width && item.y <= view.height;
    if (!item.text || !onScreen) {
      result.set(item.key, null);
      continue;
    }
    const { width, height } = labelSize(item.text);
    const prev = previous?.get(item.key)?.candidate;

    const ranked: number[] = [];
    for (let c = 0; c < total; c++) ranked.push(c);
    const cost = (c: number) => candidateCost(c, item.heading) - (c === prev ? PREVIOUS_SLOT_BONUS : 0);
    ranked.sort((a, b) => cost(a) - cost(b) || a - b);

    let chosen: { candidate: number; box: Box } | null = null;
    let fallback: { candidate: number; box: Box } | null = null;

    for (const c of ranked) {
      const s = slotBox(item, c, width, height);
      const b: Box = {
        left: item.x + s.dx,
        top: item.y + s.dy,
        right: item.x + s.dx + width,
        bottom: item.y + s.dy + height,
      };
      if (!inside(b, view)) continue;
      if (fallback === null && c < CANDIDATES_PER_RING) fallback = { candidate: c, box: b };
      if (grid.collides(b, item.key)) continue;
      chosen = { candidate: c, box: b };
      break;
    }

    // A selected aircraft is the one the user is looking at: always label it.
    if (!chosen && item.selected) chosen = fallback;

    if (!chosen) {
      result.set(item.key, null);
      continue;
    }

    const s = slotBox(item, chosen.candidate, width, height);
    grid.add({ box: chosen.box, owner: "" });
    result.set(item.key, {
      candidate: chosen.candidate,
      left: chosen.box.left,
      top: chosen.box.top,
      width,
      height,
      dx: s.dx,
      dy: s.dy,
      leader: s.leader,
      lx: s.lx,
      ly: s.ly,
    });
  }

  return result;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * HTML for one label, drawn relative to a zero-size marker anchored on the
 * aircraft: the chip at (`dx`, `dy`) and, on the outer ring, a leader line from
 * the icon's edge to the nearest point of the chip. The width is set explicitly
 * so the rendered box is exactly the box the layout reserved.
 */
export function trackLabelHtml(
  p: LabelPlacement,
  text: string,
  color: string,
  selected: boolean,
  theme: "light" | "dark",
): string {
  const dark = theme === "dark";
  const chip = [
    "position:absolute",
    `left:${p.dx}px`,
    `top:${p.dy}px`,
    `width:${p.width}px`,
    `height:${p.height}px`,
    `line-height:${p.height}px`,
    `padding:0 ${LABEL_PADDING_X}px`,
    "box-sizing:border-box",
    "font-family:ui-monospace,SFMono-Regular,Menlo,monospace",
    "font-size:10px",
    `font-weight:${selected ? 700 : 500}`,
    "white-space:nowrap",
    "overflow:hidden",
    "border-radius:2px",
    dark ? "background:rgba(15,23,42,0.78)" : "background:rgba(255,255,255,0.88)",
    dark ? `color:${color}` : "color:#0f172a",
    `border-left:2px solid ${color}`,
  ].join(";");

  let leader = "";
  if (p.leader) {
    const half = selected ? ICON_HALF_SELECTED : ICON_HALF;
    const m = Math.max(Math.abs(p.lx), Math.abs(p.ly)) || 1;
    const x1 = Math.round((p.lx * half) / m);
    const y1 = Math.round((p.ly * half) / m);
    leader =
      `<svg width="1" height="1" style="position:absolute;left:0;top:0;overflow:visible">` +
      `<line x1="${x1}" y1="${y1}" x2="${p.lx}" y2="${p.ly}" stroke="${color}" stroke-width="1" opacity="0.7"/></svg>`;
  }
  return `${leader}<div style="${chip}">${escapeHtml(text)}</div>`;
}
