"use client";
import { DEPTH_LEGEND, SEAMARK_MIN_ZOOM } from "@/lib/sea";

export interface SeaControlsProps {
  seamarks: boolean;
  onToggleSeamarks: () => void;
  seamarkOpacity: number;
  onSeamarkOpacityChange: (opacity: number) => void;
  depthColours: boolean;
  onToggleDepthColours: () => void;
  depthContours: boolean;
  onToggleDepthContours: () => void;
  /** One opacity for colours and contours: they come as one image. */
  depthOpacity: number;
  onDepthOpacityChange: (opacity: number) => void;
  /** Seamark tooltip on hover; also whether descriptions are downloaded at all. */
  seamarkHoverInfo: boolean;
  onToggleSeamarkHoverInfo: () => void;
  /** State of the descriptions for the view. */
  seamarkDetails: SeamarkDetails;
}

export interface SeamarkDetails {
  loading: boolean;
  count: number;
  error: string | null;
  /** Below the seamark zoom, or the view is too wide: nothing is asked. */
  zoomedOut: boolean;
}

function detailsText(d: SeamarkDetails): string {
  if (d.zoomedOut) return `Zoom in (${SEAMARK_MIN_ZOOM}+) for descriptions.`;
  if (d.loading) return "Loading descriptions… (a new area can take a minute)";
  return `${d.count} seamarks described.`;
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
      <input type="checkbox" checked={checked} onChange={onChange} className="accent-sky-500" />
      <span>{label}</span>
    </label>
  );
}

function Opacity({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  const percent = Math.round(value * 100);
  return (
    <label className="flex items-center gap-2">
      <span>Opacity</span>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={percent}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        aria-label={label}
        className="flex-1 accent-sky-500"
      />
      <span className="w-8 text-right tabular-nums">{percent}%</span>
    </label>
  );
}

/** The Filters panel's sea section: OpenSeaMap seamarks and EMODnet depth. */
export function SeaControls(p: SeaControlsProps) {
  const depthOn = p.depthColours || p.depthContours;
  return (
    <div className="flex flex-col gap-1">
      <Switch checked={p.seamarks} onChange={p.onToggleSeamarks} label="Seamarks (OpenSeaMap)" />
      {p.seamarks && (
        <div className="ml-5 flex flex-col gap-1 text-[11px] text-slate-500">
          <Opacity value={p.seamarkOpacity} onChange={p.onSeamarkOpacityChange} label="Seamark opacity" />
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={p.seamarkHoverInfo}
              onChange={p.onToggleSeamarkHoverInfo}
              className="accent-sky-500"
            />
            <span>Describe on hover</span>
          </label>
          {p.seamarkHoverInfo && (
            <>
              <span className="ml-5">{detailsText(p.seamarkDetails)}</span>
              {p.seamarkDetails.error && (
                <p className="ml-5 text-amber-400 break-words">{p.seamarkDetails.error}</p>
              )}
            </>
          )}
          <span className="text-[10px] text-slate-600">
            Buoys, lights and harbours, from zoom {SEAMARK_MIN_ZOOM}. Descriptions from OpenStreetMap via
            Overpass, kept a week. Data:{" "}
            <a href="https://www.openseamap.org" target="_blank" rel="noreferrer" className="hover:underline">
              OpenSeaMap
            </a>{" "}
            (ODbL)
          </span>
        </div>
      )}
      <Switch checked={p.depthColours} onChange={p.onToggleDepthColours} label="Depth colours (EMODnet)" />
      <Switch checked={p.depthContours} onChange={p.onToggleDepthContours} label="Depth contours (EMODnet)" />
      {depthOn && (
        <div className="ml-5 flex flex-col gap-1 text-[11px] text-slate-500">
          <Opacity value={p.depthOpacity} onChange={p.onDepthOpacityChange} label="Depth opacity" />
          {p.depthColours && (
            <div className="flex flex-col gap-0.5">
              <span>Depth, m</span>
              <div
                className="h-2 rounded-sm"
                style={{ background: `linear-gradient(to right, ${DEPTH_LEGEND.map((b) => b.color).join(", ")})` }}
              />
              <div className="flex justify-between tabular-nums text-[10px]">
                {DEPTH_LEGEND.map((b) => (
                  <span key={b.depthM}>{b.depthM}</span>
                ))}
              </div>
            </div>
          )}
          <span className="text-[10px] text-slate-600">
            Data:{" "}
            <a
              href="https://emodnet.ec.europa.eu/en/bathymetry"
              target="_blank"
              rel="noreferrer"
              className="hover:underline"
            >
              EMODnet Bathymetry
            </a>{" "}
            (CC BY 4.0)
          </span>
        </div>
      )}
    </div>
  );
}
