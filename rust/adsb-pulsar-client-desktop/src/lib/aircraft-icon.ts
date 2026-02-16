/**
 * Pure SVG/HTML generation for aircraft map icons.
 * The Leaflet-dependent `aircraftIcon()` wrapper lives alongside for convenience.
 */

export interface AircraftIconHtml {
  html: string;
  className: string;
  iconSize: [number, number];
  iconAnchor: [number, number];
}

/**
 * Generates the HTML/SVG content and sizing for an aircraft icon.
 * Pure function — no Leaflet dependency, fully testable.
 */
export function aircraftIconHtml(
  heading: number,
  color: string,
  selected: boolean,
): AircraftIconHtml {
  const size = selected ? 36 : 24;
  const half = size / 2;
  const stroke = selected ? "#fff" : "#000";

  // Scale polygon points proportionally to icon size
  const scale = size / 24;
  const points = [
    [12, 2],
    [6, 20],
    [12, 16],
    [18, 20],
  ]
    .map(([x, y]) => `${x * scale},${y * scale}`)
    .join(" ");

  const svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
    <g transform="rotate(${heading}, ${half}, ${half})">
      <polygon points="${points}" fill="${color}" stroke="${stroke}" stroke-width="1" opacity="0.9"/>
    </g>
  </svg>`;

  const ring = selected ? `<div class="selected-ring"></div>` : "";

  return {
    html: svg + ring,
    className: selected ? "selected-marker" : "",
    iconSize: [size, size],
    iconAnchor: [half, half],
  };
}
