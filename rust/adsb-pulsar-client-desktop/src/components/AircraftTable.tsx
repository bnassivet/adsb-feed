"use client";
import { useState, useEffect, useRef, useMemo } from "react";
import type { AircraftTrack, TrackSection } from "@/lib/types";
import type { SortKey } from "@/lib/sort-tracks";
import { altitudeToColor } from "@/lib/colors";
import { timeAgo } from "@/lib/format";

export interface SelectEvent {
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

interface Props {
  tracks: AircraftTrack[];
  historyTracks?: AircraftTrack[];
  dbHistoryTracks?: AircraftTrack[];
  importedTracks?: AircraftTrack[];
  sortKey: SortKey;
  sortAsc: boolean;
  onSort: (key: SortKey) => void;
  selectedHexIdents?: Set<string>;
  lastSelectedHexIdent?: string | null;
  onSelectTrack?: (hex: string, event: SelectEvent) => void;
  onRemoveTrack?: (hexIdent: string) => void;
  onToggleMapVisibility?: (hexIdent: string, section: TrackSection) => void;
  hiddenSections?: Map<TrackSection, Set<string>>;
  onToggleGroupVisibility?: (section: TrackSection, hexIdents: string[]) => void;
  liveSectionKey?: TrackSection;
}

function EyeIcon({ open }: { open: boolean }) {
  if (open) {
    return (
      <svg data-icon="eye-open" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    );
  }
  return (
    <svg data-icon="eye-closed" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

export function AircraftTable({ tracks, historyTracks = [], dbHistoryTracks = [], importedTracks = [], sortKey, sortAsc, onSort, selectedHexIdents, lastSelectedHexIdent, onSelectTrack, onRemoveTrack, onToggleMapVisibility, hiddenSections, onToggleGroupVisibility, liveSectionKey }: Props) {
  const [liveCollapsed, setLiveCollapsed] = useState(false);
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const [dbHistoryCollapsed, setDbHistoryCollapsed] = useState(false);
  const [importedCollapsed, setImportedCollapsed] = useState(false);

  // Tracks arrive pre-sorted from parent — no internal sorting needed
  const containerRef = useRef<HTMLDivElement>(null);

  // Memoize key arrays for GroupEyeButton props — avoids .map() on every render
  const liveKeys = useMemo(() => tracks.map(t => t.track_id ?? t.hex_ident), [tracks]);
  const historyKeys = useMemo(() => historyTracks.map(t => t.track_id ?? t.hex_ident), [historyTracks]);
  const dbHistoryKeys = useMemo(() => dbHistoryTracks.map(t => t.track_id ?? t.hex_ident), [dbHistoryTracks]);
  const importedKeys = useMemo(() => importedTracks.map(t => t.track_id ?? t.hex_ident), [importedTracks]);

  const sectionKey = liveSectionKey ?? "live";

  const isHiddenInSection = (hex: string, section: TrackSection) =>
    hiddenSections?.get(section)?.has(hex) ?? false;

  // Auto-scroll last-clicked row into view
  useEffect(() => {
    if (!lastSelectedHexIdent || !containerRef.current) return;
    const row = containerRef.current.querySelector(`[data-hex="${lastSelectedHexIdent}"]`);
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [lastSelectedHexIdent]);

  function SortHeader({ label, field }: { label: string; field: SortKey }) {
    return (
      <th
        className="px-3 py-2 text-left cursor-pointer hover:text-slate-200 select-none"
        onClick={() => onSort(field)}
      >
        {label}
        {sortKey === field && (
          <span className="ml-1">{sortAsc ? "\u25B2" : "\u25BC"}</span>
        )}
      </th>
    );
  }

  function GroupEyeButton({ section, trackHexes }: { section: TrackSection; trackHexes: string[] }) {
    if (!onToggleGroupVisibility) return null;
    const sectionSet = hiddenSections?.get(section);
    const allHidden = trackHexes.length > 0 && sectionSet != null && trackHexes.every(h => sectionSet.has(h));
    return (
      <button
        onClick={(e) => { e.stopPropagation(); onToggleGroupVisibility(section, trackHexes); }}
        data-testid={`group-visibility-${section}`}
        className={`mr-1.5 transition text-xs leading-none ${allHidden ? "text-slate-600 hover:text-slate-300" : "text-slate-400 hover:text-slate-200"}`}
        title={allHidden ? `Show ${section} group on map` : `Hide ${section} group from map`}
      >
        <EyeIcon open={!allHidden} />
      </button>
    );
  }

  return (
    <div ref={containerRef} className="overflow-auto h-full">
      <table className="w-full text-xs">
        <thead className="bg-slate-800 text-slate-400 sticky top-0">
          <tr>
            <SortHeader label="Callsign" field="callsign" />
            <SortHeader label="Hex" field="hex_ident" />
            <SortHeader label="Alt (ft)" field="altitude" />
            <SortHeader label="Spd (kts)" field="ground_speed" />
            <th className="px-3 py-2 text-left">Hdg</th>
            <th className="px-3 py-2 text-left">V/S</th>
            <SortHeader label="Squawk" field="squawk" />
            <th className="px-3 py-2 text-left">Lat</th>
            <th className="px-3 py-2 text-left">Lon</th>
            <SortHeader label="RxTS" field="last_seen" />
            <SortHeader label="Msg#" field="message_count" />
            {onToggleMapVisibility && <th className="px-1 py-2 w-8" title="Map visibility" />}
            {onRemoveTrack && <th className="px-1 py-2 w-8" />}
          </tr>
        </thead>
        <tbody className="text-slate-300">
          {/* Live header — collapsible */}
          {tracks.length > 0 && (
            <tr
              data-testid="live-section-header"
              className="cursor-pointer select-none"
              onClick={() => setLiveCollapsed(prev => !prev)}
            >
              <td colSpan={11} className="px-3 py-1 bg-slate-800/80">
                <GroupEyeButton section={sectionKey} trackHexes={liveKeys} />
                <span className="text-[10px] text-green-500 uppercase tracking-wider">
                  {liveCollapsed ? "\u25B8" : "\u25BE"} Live ({tracks.length})
                </span>
              </td>
            </tr>
          )}

          {/* Live rows */}
          {!liveCollapsed && tracks.map((t) => {
            const key = t.track_id ?? t.hex_ident;
            const isSelected = selectedHexIdents?.has(key) ?? false;
            const isHidden = isHiddenInSection(key, sectionKey);
            return (
            <tr
              key={key}
              data-testid={`row-${key}`}
              data-hex={key}
              onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
              onClick={(e) => onSelectTrack?.(key, { shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey })}
              className={`border-b border-slate-800 ${
                isSelected
                  ? "bg-blue-900/40 hover:bg-blue-900/50"
                  : "hover:bg-slate-800/50"
              }${isHidden ? " opacity-40" : ""}${onSelectTrack ? " cursor-pointer" : ""}`}
            >
              <td className="px-3 py-1.5 font-mono font-semibold">
                {t.hex_ident.startsWith("SIM-") && (
                  <span className="inline-block mr-1.5 px-1 py-0.5 text-[9px] font-bold rounded bg-emerald-600/30 text-emerald-400 leading-none">
                    SIM
                  </span>
                )}
                {t.callsign ?? "—"}
              </td>
              <td className="px-3 py-1.5 font-mono text-slate-400">
                {t.hex_ident}
              </td>
              <td className="px-3 py-1.5 font-mono">
                <span style={{ color: altitudeToColor(t.altitude) }}>
                  {t.altitude?.toLocaleString() ?? "—"}
                </span>
              </td>
              <td className="px-3 py-1.5 font-mono">
                {t.ground_speed?.toFixed(0) ?? "—"}
              </td>
              <td className="px-3 py-1.5 font-mono">
                {t.track?.toFixed(0) ?? "—"}{t.track !== null ? "\u00B0" : ""}
              </td>
              <td className="px-3 py-1.5 font-mono">
                {t.vertical_rate?.toFixed(0) ?? "—"}
              </td>
              <td className="px-3 py-1.5 font-mono text-slate-400">
                {t.squawk ?? "—"}
              </td>
              <td className="px-3 py-1.5 font-mono text-slate-500">
                {t.latitude?.toFixed(4) ?? "—"}
              </td>
              <td className="px-3 py-1.5 font-mono text-slate-500">
                {t.longitude?.toFixed(4) ?? "—"}
              </td>
              <td className="px-3 py-1.5 font-mono text-slate-500">
                {timeAgo(t.last_seen)}
              </td>
              <td className="px-3 py-1.5 font-mono text-slate-400">
                {t.message_count.toLocaleString()}
              </td>
              {onToggleMapVisibility && (
                <td className="px-1 py-1.5 text-center">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const isMultiSelected = selectedHexIdents && selectedHexIdents.has(key) && selectedHexIdents.size > 1;
                      if (isMultiSelected) {
                        const selectedInSection = liveKeys.filter(h => selectedHexIdents.has(h));
                        selectedInSection.forEach(h => onToggleMapVisibility(h, sectionKey));
                      } else {
                        onToggleMapVisibility(key, sectionKey);
                      }
                    }}
                    data-testid={`visibility-${sectionKey}-${key}`}
                    className={`transition text-xs leading-none ${isHidden ? "text-slate-600 hover:text-slate-300" : "text-slate-400 hover:text-slate-200"}`}
                    title={isHidden ? `Show ${t.hex_ident} on map` : `Hide ${t.hex_ident} from map`}
                  >
                    <EyeIcon open={!isHidden} />
                  </button>
                </td>
              )}
              {onRemoveTrack && (
                <td className="px-1 py-1.5 text-center">
                  <button
                    onClick={(e) => { e.stopPropagation(); onRemoveTrack(key); }}
                    data-testid={`remove-${key}`}
                    className="text-slate-600 hover:text-red-400 transition text-xs leading-none"
                    title={`Remove ${t.hex_ident}`}
                  >
                    ×
                  </button>
                </td>
              )}
            </tr>
            );
          })}

          {/* History header — collapsible */}
          {historyTracks.length > 0 && (
            <tr
              data-testid="history-section-header"
              className="cursor-pointer select-none"
              onClick={() => setHistoryCollapsed(prev => !prev)}
            >
              <td colSpan={11} className="px-3 py-1 bg-slate-800/80">
                <GroupEyeButton section="history" trackHexes={historyKeys} />
                <span className="text-[10px] text-slate-500 uppercase tracking-wider">
                  {historyCollapsed ? "\u25B8" : "\u25BE"} History ({historyTracks.length})
                </span>
              </td>
            </tr>
          )}

          {/* History rows — dimmed */}
          {!historyCollapsed && historyTracks.map((t) => {
            const key = t.track_id ?? t.hex_ident;
            const isSelected = selectedHexIdents?.has(key) ?? false;
            const isHidden = isHiddenInSection(key, "history");
            return (
            <tr
              key={`hist-${key}`}
              data-testid={`row-hist-${key}`}
              data-hex={key}
              onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
              onClick={(e) => onSelectTrack?.(key, { shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey })}
              className={`border-b border-slate-800 ${
                isSelected
                  ? "bg-blue-900/40 hover:bg-blue-900/50"
                  : `hover:bg-slate-800/50${isHidden ? " opacity-40" : " opacity-40"}`
              }${onSelectTrack ? " cursor-pointer" : ""}`}
            >
              <td className="px-3 py-1.5 font-mono font-semibold">
                {t.callsign ?? "—"}
              </td>
              <td className="px-3 py-1.5 font-mono text-slate-400">
                {t.hex_ident}
              </td>
              <td className="px-3 py-1.5 font-mono">
                <span style={{ color: altitudeToColor(t.altitude) }}>
                  {t.altitude?.toLocaleString() ?? "—"}
                </span>
              </td>
              <td className="px-3 py-1.5 font-mono">
                {t.ground_speed?.toFixed(0) ?? "—"}
              </td>
              <td className="px-3 py-1.5 font-mono" colSpan={2}>
                <span className="text-slate-500 italic">
                  {timeAgo(t.last_seen)}
                </span>
              </td>
              <td className="px-3 py-1.5 font-mono text-slate-400">
                {t.squawk ?? "—"}
              </td>
              <td className="px-3 py-1.5 font-mono text-slate-500">
                {t.latitude?.toFixed(4) ?? "—"}
              </td>
              <td className="px-3 py-1.5 font-mono text-slate-500">
                {t.longitude?.toFixed(4) ?? "—"}
              </td>
              <td className="px-3 py-1.5 font-mono text-slate-500">
                {timeAgo(t.last_seen)}
              </td>
              <td className="px-3 py-1.5 font-mono text-slate-400">
                {t.message_count.toLocaleString()}
              </td>
              {onToggleMapVisibility && (
                <td className="px-1 py-1.5 text-center">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const isMultiSelected = selectedHexIdents && selectedHexIdents.has(key) && selectedHexIdents.size > 1;
                      if (isMultiSelected) {
                        const selectedInSection = historyKeys.filter(h => selectedHexIdents.has(h));
                        selectedInSection.forEach(h => onToggleMapVisibility(h, "history"));
                      } else {
                        onToggleMapVisibility(key, "history");
                      }
                    }}
                    data-testid={`visibility-history-${key}`}
                    className={`transition text-xs leading-none ${isHidden ? "text-slate-600 hover:text-slate-300" : "text-slate-400 hover:text-slate-200"}`}
                    title={isHidden ? `Show ${t.hex_ident} on map` : `Hide ${t.hex_ident} from map`}
                  >
                    <EyeIcon open={!isHidden} />
                  </button>
                </td>
              )}
            </tr>
            );
          })}

          {/* DB History header — collapsible */}
          {dbHistoryTracks.length > 0 && (
            <tr
              data-testid="dbhistory-section-header"
              className="cursor-pointer select-none"
              onClick={() => setDbHistoryCollapsed(prev => !prev)}
            >
              <td colSpan={11} className="px-3 py-1 bg-cyan-900/20">
                <GroupEyeButton section="dbHistory" trackHexes={dbHistoryKeys} />
                <span className="text-[10px] text-cyan-500 uppercase tracking-wider">
                  {dbHistoryCollapsed ? "\u25B8" : "\u25BE"} DB History ({dbHistoryTracks.length})
                </span>
              </td>
            </tr>
          )}

          {/* DB History rows — cyan tint */}
          {!dbHistoryCollapsed && dbHistoryTracks.map((t) => {
            const key = t.track_id ?? t.hex_ident;
            const isSelected = selectedHexIdents?.has(key) ?? false;
            const isHidden = isHiddenInSection(key, "dbHistory");
            return (
            <tr
              key={`dbhist-${key}`}
              data-testid={`row-dbhist-${key}`}
              data-hex={key}
              onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
              onClick={(e) => onSelectTrack?.(key, { shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey })}
              className={`border-b border-slate-800 ${
                isSelected
                  ? "bg-cyan-900/40 hover:bg-cyan-900/50"
                  : `hover:bg-slate-800/50${isHidden ? " opacity-40" : " opacity-60"}`
              }${onSelectTrack ? " cursor-pointer" : ""}`}
            >
              <td className="px-3 py-1.5 font-mono font-semibold text-cyan-300">{t.callsign ?? "—"}</td>
              <td className="px-3 py-1.5 font-mono text-cyan-400/60">{t.hex_ident}</td>
              <td className="px-3 py-1.5 font-mono">
                <span style={{ color: altitudeToColor(t.altitude) }}>{t.altitude?.toLocaleString() ?? "—"}</span>
              </td>
              <td className="px-3 py-1.5 font-mono">{t.ground_speed?.toFixed(0) ?? "—"}</td>
              <td className="px-3 py-1.5 font-mono">{t.track?.toFixed(0) ?? "—"}{t.track !== null ? "\u00B0" : ""}</td>
              <td className="px-3 py-1.5 font-mono">{t.vertical_rate?.toFixed(0) ?? "—"}</td>
              <td className="px-3 py-1.5 font-mono text-slate-400">{t.squawk ?? "—"}</td>
              <td className="px-3 py-1.5 font-mono text-slate-500">{t.latitude?.toFixed(4) ?? "—"}</td>
              <td className="px-3 py-1.5 font-mono text-slate-500">{t.longitude?.toFixed(4) ?? "—"}</td>
              <td className="px-3 py-1.5 font-mono text-slate-500">{timeAgo(t.last_seen)}</td>
              <td className="px-3 py-1.5 font-mono text-slate-400">{t.message_count.toLocaleString()}</td>
              {onToggleMapVisibility && (
                <td className="px-1 py-1.5 text-center">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const isMultiSelected = selectedHexIdents && selectedHexIdents.has(key) && selectedHexIdents.size > 1;
                      if (isMultiSelected) {
                        const selectedInSection = dbHistoryKeys.filter(h => selectedHexIdents.has(h));
                        selectedInSection.forEach(h => onToggleMapVisibility(h, "dbHistory"));
                      } else {
                        onToggleMapVisibility(key, "dbHistory");
                      }
                    }}
                    data-testid={`visibility-dbHistory-${key}`}
                    className={`transition text-xs leading-none ${isHidden ? "text-slate-600 hover:text-slate-300" : "text-slate-400 hover:text-slate-200"}`}
                    title={isHidden ? `Show ${t.hex_ident} on map` : `Hide ${t.hex_ident} from map`}
                  >
                    <EyeIcon open={!isHidden} />
                  </button>
                </td>
              )}
            </tr>
            );
          })}

          {/* Imported header — collapsible */}
          {importedTracks.length > 0 && (
            <tr
              data-testid="imported-section-header"
              className="cursor-pointer select-none"
              onClick={() => setImportedCollapsed(prev => !prev)}
            >
              <td colSpan={11} className="px-3 py-1 bg-indigo-900/30">
                <GroupEyeButton section="imported" trackHexes={importedKeys} />
                <span className="text-[10px] text-indigo-400 uppercase tracking-wider">
                  {importedCollapsed ? "\u25B8" : "\u25BE"} Imported ({importedTracks.length})
                </span>
              </td>
            </tr>
          )}

          {/* Imported rows — indigo tint */}
          {!importedCollapsed && importedTracks.map((t) => {
            const key = t.track_id ?? t.hex_ident;
            const isSelected = selectedHexIdents?.has(key) ?? false;
            const isHidden = isHiddenInSection(key, "imported");
            return (
            <tr
              key={`imported-${key}`}
              data-testid={`row-imported-${key}`}
              data-hex={key}
              onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
              onClick={(e) => onSelectTrack?.(key, { shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey })}
              className={`border-b border-slate-800 ${
                isSelected
                  ? "bg-indigo-900/40 hover:bg-indigo-900/50"
                  : `hover:bg-slate-800/50${isHidden ? " opacity-40" : " opacity-60"}`
              }${onSelectTrack ? " cursor-pointer" : ""}`}
            >
              <td className="px-3 py-1.5 font-mono font-semibold text-indigo-300">{t.callsign ?? "—"}</td>
              <td className="px-3 py-1.5 font-mono text-indigo-400/60">{t.hex_ident}</td>
              <td className="px-3 py-1.5 font-mono">
                <span style={{ color: altitudeToColor(t.altitude) }}>{t.altitude?.toLocaleString() ?? "—"}</span>
              </td>
              <td className="px-3 py-1.5 font-mono">{t.ground_speed?.toFixed(0) ?? "—"}</td>
              <td className="px-3 py-1.5 font-mono">{t.track?.toFixed(0) ?? "—"}{t.track !== null ? "\u00B0" : ""}</td>
              <td className="px-3 py-1.5 font-mono">{t.vertical_rate?.toFixed(0) ?? "—"}</td>
              <td className="px-3 py-1.5 font-mono text-slate-400">{t.squawk ?? "—"}</td>
              <td className="px-3 py-1.5 font-mono text-slate-500">{t.latitude?.toFixed(4) ?? "—"}</td>
              <td className="px-3 py-1.5 font-mono text-slate-500">{t.longitude?.toFixed(4) ?? "—"}</td>
              <td className="px-3 py-1.5 font-mono text-slate-500">{timeAgo(t.last_seen)}</td>
              <td className="px-3 py-1.5 font-mono text-slate-400">{t.message_count.toLocaleString()}</td>
              {onToggleMapVisibility && (
                <td className="px-1 py-1.5 text-center">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      const isMultiSelected = selectedHexIdents && selectedHexIdents.has(key) && selectedHexIdents.size > 1;
                      if (isMultiSelected) {
                        const selectedInSection = importedKeys.filter(h => selectedHexIdents.has(h));
                        selectedInSection.forEach(h => onToggleMapVisibility(h, "imported"));
                      } else {
                        onToggleMapVisibility(key, "imported");
                      }
                    }}
                    data-testid={`visibility-imported-${key}`}
                    className={`transition text-xs leading-none ${isHidden ? "text-slate-600 hover:text-slate-300" : "text-slate-400 hover:text-slate-200"}`}
                    title={isHidden ? `Show ${t.hex_ident} on map` : `Hide ${t.hex_ident} from map`}
                  >
                    <EyeIcon open={!isHidden} />
                  </button>
                </td>
              )}
            </tr>
            );
          })}

          {tracks.length === 0 && historyTracks.length === 0 && dbHistoryTracks.length === 0 && importedTracks.length === 0 && (
            <tr>
              <td
                colSpan={11}
                className="px-3 py-8 text-center text-slate-500"
              >
                No aircraft tracked
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
