"use client";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
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

// ── Flat virtual list item types ─────────────────────────────────────────────

type VirtualRowHeader = {
  kind: "header";
  section: TrackSection;
  label: string;
  color: string;
  bgClass: string;
  count: number;
  trackKeys: string[];
};

type VirtualRowData = {
  kind: "data";
  section: TrackSection;
  track: AircraftTrack;
  key: string;
};

type VirtualRow = VirtualRowHeader | VirtualRowData;

const HEADER_HEIGHT = 28;
const ROW_HEIGHT = 32;

// Fixed column widths to keep header + virtualized body aligned.
// Each inner <table> is independent, so table-layout:fixed + matching <colgroup> is required.
const COL_WIDTHS = [
  "14%",  // Callsign
  "10%",  // Hex
  "9%",   // Alt
  "8%",   // Spd
  "6%",   // Hdg
  "6%",   // V/S
  "8%",   // Squawk
  "10%",  // Lat
  "10%",  // Lon
  "11%",  // RxTS
  "8%",   // Msg#
];

function ColGroup({ hasVisibility, hasRemove }: { hasVisibility: boolean; hasRemove: boolean }) {
  return (
    <colgroup>
      {COL_WIDTHS.map((w, i) => <col key={i} style={{ width: w }} />)}
      {hasVisibility && <col style={{ width: 32 }} />}
      {hasRemove && <col style={{ width: 32 }} />}
    </colgroup>
  );
}

export function AircraftTable({ tracks, historyTracks = [], dbHistoryTracks = [], importedTracks = [], sortKey, sortAsc, onSort, selectedHexIdents, lastSelectedHexIdent, onSelectTrack, onRemoveTrack, onToggleMapVisibility, hiddenSections, onToggleGroupVisibility, liveSectionKey }: Props) {
  const [liveCollapsed, setLiveCollapsed] = useState(false);
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const [dbHistoryCollapsed, setDbHistoryCollapsed] = useState(false);
  const [importedCollapsed, setImportedCollapsed] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);

  const sectionKey = liveSectionKey ?? "live";

  const isHiddenInSection = useCallback(
    (hex: string, section: TrackSection) => hiddenSections?.get(section)?.has(hex) ?? false,
    [hiddenSections],
  );

  // Build flat virtual list of all rows (headers + data)
  const flatRows = useMemo(() => {
    const rows: VirtualRow[] = [];

    const addSection = (
      sectionId: TrackSection,
      label: string,
      color: string,
      bgClass: string,
      sectionTracks: AircraftTrack[],
      collapsed: boolean,
    ) => {
      if (sectionTracks.length === 0) return;
      const trackKeys = sectionTracks.map(t => t.track_id ?? t.hex_ident);
      rows.push({ kind: "header", section: sectionId, label, color, bgClass, count: sectionTracks.length, trackKeys });
      if (!collapsed) {
        for (const t of sectionTracks) {
          rows.push({ kind: "data", section: sectionId, track: t, key: t.track_id ?? t.hex_ident });
        }
      }
    };

    addSection(sectionKey, "Live", "text-green-500", "bg-slate-800/80", tracks, liveCollapsed);
    addSection("history", "History", "text-slate-500", "bg-slate-800/80", historyTracks, historyCollapsed);
    addSection("dbHistory", "DB History", "text-cyan-500", "bg-cyan-900/20", dbHistoryTracks, dbHistoryCollapsed);
    addSection("imported", "Imported", "text-indigo-400", "bg-indigo-900/30", importedTracks, importedCollapsed);

    return rows;
  }, [sectionKey, tracks, historyTracks, dbHistoryTracks, importedTracks, liveCollapsed, historyCollapsed, dbHistoryCollapsed, importedCollapsed]);

  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: (index) => flatRows[index].kind === "header" ? HEADER_HEIGHT : ROW_HEIGHT,
    overscan: 10,
  });

  // Auto-scroll last-clicked row into view
  useEffect(() => {
    if (!lastSelectedHexIdent) return;
    const idx = flatRows.findIndex(r => r.kind === "data" && r.key === lastSelectedHexIdent);
    if (idx >= 0) {
      virtualizer.scrollToIndex(idx, { align: "auto", behavior: "smooth" });
    }
  }, [lastSelectedHexIdent, flatRows, virtualizer]);

  const toggleCollapse = useCallback((section: TrackSection) => {
    switch (section) {
      case "live": setLiveCollapsed(prev => !prev); break;
      case "history": setHistoryCollapsed(prev => !prev); break;
      case "dbHistory": setDbHistoryCollapsed(prev => !prev); break;
      case "imported": setImportedCollapsed(prev => !prev); break;
    }
  }, []);

  const colSpan = 11 + (onToggleMapVisibility ? 1 : 0) + (onRemoveTrack ? 1 : 0);

  // Get the keys for a section (from the header row) for multi-select visibility toggle
  const getSectionKeys = useCallback(
    (section: TrackSection): string[] => {
      const header = flatRows.find(r => r.kind === "header" && r.section === section);
      return header?.kind === "header" ? header.trackKeys : [];
    },
    [flatRows],
  );

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

  const renderHeaderRow = (row: VirtualRowHeader) => {
    const isCollapsed =
      row.section === sectionKey ? liveCollapsed
      : row.section === "history" ? historyCollapsed
      : row.section === "dbHistory" ? dbHistoryCollapsed
      : importedCollapsed;

    return (
      <tr
        data-testid={`${row.section === sectionKey ? "live" : row.section.toLowerCase()}-section-header`}
        className="cursor-pointer select-none"
        onClick={() => toggleCollapse(row.section)}
      >
        <td colSpan={colSpan} className={`px-3 py-1 ${row.bgClass}`}>
          <GroupEyeButton section={row.section} trackHexes={row.trackKeys} />
          <span className={`text-[10px] ${row.color} uppercase tracking-wider`}>
            {isCollapsed ? "\u25B8" : "\u25BE"} {row.label} ({row.count})
          </span>
        </td>
      </tr>
    );
  };

  const renderDataRow = (row: VirtualRowData) => {
    const { track: t, key, section } = row;
    const isSelected = selectedHexIdents?.has(key) ?? false;
    const isHidden = isHiddenInSection(key, section);
    const sectionKeys = getSectionKeys(section);

    // Section-specific styling
    const isHistory = section === "history";
    const isDbHistory = section === "dbHistory";
    const isImported = section === "imported";

    const selectedBg = isDbHistory ? "bg-cyan-900/40 hover:bg-cyan-900/50"
      : isImported ? "bg-indigo-900/40 hover:bg-indigo-900/50"
      : "bg-blue-900/40 hover:bg-blue-900/50";
    const unselectedClass = isHidden ? " opacity-40"
      : (isHistory ? " opacity-40" : isDbHistory || isImported ? " opacity-60" : "");

    const callsignClass = isDbHistory ? "text-cyan-300"
      : isImported ? "text-indigo-300"
      : "";
    const hexClass = isDbHistory ? "text-cyan-400/60"
      : isImported ? "text-indigo-400/60"
      : "text-slate-400";

    return (
      <tr
        key={key}
        data-testid={`row-${isHistory ? "hist-" : isDbHistory ? "dbhist-" : isImported ? "imported-" : ""}${key}`}
        data-hex={key}
        onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); }}
        onClick={(e) => onSelectTrack?.(key, { shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey })}
        className={`border-b border-slate-800 ${
          isSelected ? selectedBg : `hover:bg-slate-800/50${unselectedClass}`
        }${onSelectTrack ? " cursor-pointer" : ""}`}
      >
        <td className="px-3 py-1.5 font-mono font-semibold">
          {!isHistory && !isDbHistory && !isImported && t.hex_ident.startsWith("SIM-") && (
            <span className="inline-block mr-1.5 px-1 py-0.5 text-[9px] font-bold rounded bg-emerald-600/30 text-emerald-400 leading-none">
              SIM
            </span>
          )}
          <span className={callsignClass}>{t.callsign ?? "—"}</span>
        </td>
        <td className={`px-3 py-1.5 font-mono ${hexClass}`}>{t.hex_ident}</td>
        <td className="px-3 py-1.5 font-mono">
          <span style={{ color: altitudeToColor(t.altitude) }}>
            {t.altitude?.toLocaleString() ?? "—"}
          </span>
        </td>
        <td className="px-3 py-1.5 font-mono">{t.ground_speed?.toFixed(0) ?? "—"}</td>
        <td className="px-3 py-1.5 font-mono">
          {isHistory
            ? <span className="text-slate-500 italic">{timeAgo(t.last_seen)}</span>
            : <>{t.track?.toFixed(0) ?? "—"}{t.track !== null ? "\u00B0" : ""}</>}
        </td>
        <td className="px-3 py-1.5 font-mono">
          {isHistory ? "—" : (t.vertical_rate?.toFixed(0) ?? "—")}
        </td>
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
                  const selectedInSection = sectionKeys.filter(h => selectedHexIdents.has(h));
                  selectedInSection.forEach(h => onToggleMapVisibility(h, section));
                } else {
                  onToggleMapVisibility(key, section);
                }
              }}
              data-testid={`visibility-${section}-${key}`}
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
  };

  const isEmpty = tracks.length === 0 && historyTracks.length === 0 && dbHistoryTracks.length === 0 && importedTracks.length === 0;

  return (
    <div ref={containerRef} className="overflow-auto h-full">
      <table className="w-full text-xs" style={{ tableLayout: "fixed" }}>
        <ColGroup hasVisibility={!!onToggleMapVisibility} hasRemove={!!onRemoveTrack} />
        <thead className="bg-slate-800 text-slate-400 sticky top-0 z-10">
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
          {isEmpty ? (
            <tr>
              <td colSpan={colSpan} className="px-3 py-8 text-center text-slate-500">
                No aircraft tracked
              </td>
            </tr>
          ) : (
            <tr>
              <td colSpan={colSpan} style={{ padding: 0, border: "none" }}>
                <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                  {virtualizer.getVirtualItems().map((virtualItem) => {
                    const row = flatRows[virtualItem.index];
                    return (
                      <div
                        key={virtualItem.key}
                        data-index={virtualItem.index}
                        ref={virtualizer.measureElement}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          transform: `translateY(${virtualItem.start}px)`,
                        }}
                      >
                        <table className="w-full text-xs" style={{ tableLayout: "fixed" }}>
                          <ColGroup hasVisibility={!!onToggleMapVisibility} hasRemove={!!onRemoveTrack} />
                          <tbody className="text-slate-300">
                            {row.kind === "header"
                              ? renderHeaderRow(row)
                              : renderDataRow(row)}
                          </tbody>
                        </table>
                      </div>
                    );
                  })}
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
