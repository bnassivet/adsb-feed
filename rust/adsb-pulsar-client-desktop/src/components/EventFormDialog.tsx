"use client";
import { useState, useCallback, useEffect, useRef } from "react";
import type {
  CreateEventOfInterest,
  UpdateEventOfInterest,
  EventOfInterest,
  MapPickResult,
} from "@/lib/types";

type TimeMode = "point" | "range";
type LocationMode = "none" | "point" | "area";

export interface EventFormDialogProps {
  /** If provided, the form is in "edit" mode for this event. */
  editEvent?: EventOfInterest;
  /** Pre-fill latitude (e.g., from map right-click). */
  initialLat?: number | null;
  /** Pre-fill longitude (e.g., from map right-click). */
  initialLng?: number | null;
  /** Pre-fill linked hex_idents (e.g., from selected aircraft). */
  initialHexIdents?: string;
  onSave: (
    event: CreateEventOfInterest | UpdateEventOfInterest
  ) => Promise<void>;
  onCancel: () => void;
  /** Whether the form is currently in "picking from map" mode. */
  isPickingFromMap?: boolean;
  /** Request map picking mode (point or area). */
  onStartMapPick?: (mode: "point" | "area") => void;
  /** Result from map picking (set by parent after pick completes). */
  mapPickResult?: MapPickResult | null;
}

function msToDatetimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function datetimeLocalToMs(value: string): number {
  return new Date(value).getTime();
}

export function EventFormDialog({
  editEvent,
  initialLat,
  initialLng,
  initialHexIdents,
  onSave,
  onCancel,
  isPickingFromMap,
  onStartMapPick,
  mapPickResult,
}: EventFormDialogProps) {
  const isEdit = !!editEvent;

  const [title, setTitle] = useState(editEvent?.title ?? "");
  const [description, setDescription] = useState(
    editEvent?.description ?? ""
  );
  const [category, setCategory] = useState(editEvent?.category ?? "");

  // Time
  const hasEndTime = editEvent?.end_timestamp_ms != null;
  const [timeMode, setTimeMode] = useState<TimeMode>(
    hasEndTime ? "range" : "point"
  );
  const [timestampStr, setTimestampStr] = useState(
    msToDatetimeLocal(editEvent?.timestamp_ms ?? Date.now())
  );
  const [endTimestampStr, setEndTimestampStr] = useState(
    hasEndTime ? msToDatetimeLocal(editEvent!.end_timestamp_ms!) : ""
  );

  // Location
  const hasPoint =
    editEvent?.latitude != null || initialLat != null;
  const hasArea = editEvent?.bbox_north != null;
  const [locationMode, setLocationMode] = useState<LocationMode>(
    hasArea ? "area" : hasPoint ? "point" : "none"
  );
  const [lat, setLat] = useState(
    String(editEvent?.latitude ?? initialLat ?? "")
  );
  const [lng, setLng] = useState(
    String(editEvent?.longitude ?? initialLng ?? "")
  );
  const [bboxNorth, setBboxNorth] = useState(
    String(editEvent?.bbox_north ?? "")
  );
  const [bboxSouth, setBboxSouth] = useState(
    String(editEvent?.bbox_south ?? "")
  );
  const [bboxEast, setBboxEast] = useState(
    String(editEvent?.bbox_east ?? "")
  );
  const [bboxWest, setBboxWest] = useState(
    String(editEvent?.bbox_west ?? "")
  );

  // Linked aircraft
  const [linkedHex, setLinkedHex] = useState(
    editEvent?.linked_hex_idents ?? initialHexIdents ?? ""
  );

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locationDetailsRef = useRef<HTMLDetailsElement>(null);

  // Drag state for movable dialog. Self-contained drag: each mousedown captures the start mouse
  // position and current offset in the closure and attaches move/up listeners removed on mouseup.
  // Avoids ref-backed drag state and handler self-reference.
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  const handleDragDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const mx = e.clientX;
      const my = e.clientY;
      const ox = dragOffset.x;
      const oy = dragOffset.y;

      function onMove(ev: MouseEvent) {
        setDragOffset({ x: ox + (ev.clientX - mx), y: oy + (ev.clientY - my) });
      }
      function onUp() {
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }

      document.body.style.userSelect = "none";
      document.body.style.cursor = "move";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [dragOffset],
  );

  // Apply map pick result to internal state
  useEffect(() => {
    if (!mapPickResult) return;
    if (mapPickResult.type === "point") {
      setLocationMode("point");
      setLat(String(mapPickResult.lat));
      setLng(String(mapPickResult.lng));
    } else {
      setLocationMode("area");
      setBboxNorth(String(mapPickResult.north));
      setBboxSouth(String(mapPickResult.south));
      setBboxEast(String(mapPickResult.east));
      setBboxWest(String(mapPickResult.west));
    }
    // Auto-open the location details section
    if (locationDetailsRef.current) {
      locationDetailsRef.current.open = true;
    }
  }, [mapPickResult]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!title.trim() || !description.trim()) return;

      setSaving(true);
      setError(null);

      try {
        const timestamp_ms = datetimeLocalToMs(timestampStr);
        const end_timestamp_ms =
          timeMode === "range" && endTimestampStr
            ? datetimeLocalToMs(endTimestampStr)
            : null;

        const latitude =
          locationMode === "point" && lat ? parseFloat(lat) : null;
        const longitude =
          locationMode === "point" && lng ? parseFloat(lng) : null;
        const bbox_north =
          locationMode === "area" && bboxNorth
            ? parseFloat(bboxNorth)
            : null;
        const bbox_south =
          locationMode === "area" && bboxSouth
            ? parseFloat(bboxSouth)
            : null;
        const bbox_east =
          locationMode === "area" && bboxEast
            ? parseFloat(bboxEast)
            : null;
        const bbox_west =
          locationMode === "area" && bboxWest
            ? parseFloat(bboxWest)
            : null;

        const linked_hex_idents = linkedHex.trim() || null;
        const cat = category.trim() || null;

        if (isEdit && editEvent) {
          await onSave({
            id: editEvent.id,
            title: title.trim(),
            description: description.trim(),
            timestamp_ms,
            end_timestamp_ms,
            latitude,
            longitude,
            bbox_north,
            bbox_south,
            bbox_east,
            bbox_west,
            category: cat,
            linked_hex_idents,
          } as UpdateEventOfInterest);
        } else {
          await onSave({
            title: title.trim(),
            description: description.trim(),
            timestamp_ms,
            end_timestamp_ms,
            latitude,
            longitude,
            bbox_north,
            bbox_south,
            bbox_east,
            bbox_west,
            category: cat,
            linked_hex_idents,
          } as CreateEventOfInterest);
        }
      } catch (err) {
        setError(String(err));
      } finally {
        setSaving(false);
      }
    },
    [
      title,
      description,
      category,
      timestampStr,
      endTimestampStr,
      timeMode,
      locationMode,
      lat,
      lng,
      bboxNorth,
      bboxSouth,
      bboxEast,
      bboxWest,
      linkedHex,
      isEdit,
      editEvent,
      onSave,
    ]
  );

  const inputClass =
    "w-full px-2 py-1 text-xs bg-slate-800 border border-slate-600 rounded text-slate-200 focus:border-blue-500 focus:outline-none";
  const labelClass = "block text-xs text-slate-400 mb-1";

  // Picking banner mode — collapses the full form while user picks on map
  if (isPickingFromMap) {
    return (
      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[1200] bg-slate-900 border border-amber-600 rounded-lg shadow-xl px-4 py-2 flex items-center gap-3">
        <span className="text-xs text-amber-200">
          Click on the map to {locationMode === "area" ? "draw two corners for the area" : "place a point"}.
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="px-2 py-0.5 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded transition"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="bg-slate-900 border border-slate-700 rounded-lg shadow-xl w-[420px] max-h-[80vh] overflow-y-auto"
        style={{ transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          onMouseDown={handleDragDown}
          className="flex items-center justify-between px-4 pt-4 pb-2 cursor-move select-none"
        >
          <h2 className="text-sm font-semibold text-slate-200">
            {isEdit ? "Edit Event" : "New Event of Interest"}
          </h2>
        </div>
        <div className="px-4 pb-4">

        {error && (
          <div className="text-xs text-red-400 mb-2">{error}</div>
        )}

        {/* Title */}
        <div className="mb-2">
          <label className={labelClass}>Title *</label>
          <input
            type="text"
            className={inputClass}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            autoFocus
          />
        </div>

        {/* Description */}
        <div className="mb-2">
          <label className={labelClass}>Description *</label>
          <textarea
            className={`${inputClass} h-16 resize-y`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            required
          />
        </div>

        {/* Category */}
        <div className="mb-2">
          <label className={labelClass}>Category</label>
          <input
            type="text"
            className={inputClass}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="observation, military, emergency, anomaly..."
            list="event-categories"
          />
          <datalist id="event-categories">
            <option value="observation" />
            <option value="military" />
            <option value="emergency" />
            <option value="anomaly" />
            <option value="airspace" />
          </datalist>
        </div>

        {/* Time */}
        <div className="mb-2">
          <label className={labelClass}>Time</label>
          <div className="flex gap-2 mb-1">
            <button
              type="button"
              className={`px-2 py-0.5 text-xs rounded ${timeMode === "point" ? "bg-blue-600 text-white" : "bg-slate-700 text-slate-400"}`}
              onClick={() => setTimeMode("point")}
            >
              Point
            </button>
            <button
              type="button"
              className={`px-2 py-0.5 text-xs rounded ${timeMode === "range" ? "bg-blue-600 text-white" : "bg-slate-700 text-slate-400"}`}
              onClick={() => setTimeMode("range")}
            >
              Range
            </button>
          </div>
          <input
            type="datetime-local"
            className={inputClass}
            value={timestampStr}
            onChange={(e) => setTimestampStr(e.target.value)}
            required
          />
          {timeMode === "range" && (
            <input
              type="datetime-local"
              className={`${inputClass} mt-1`}
              value={endTimestampStr}
              onChange={(e) => setEndTimestampStr(e.target.value)}
              placeholder="End time"
            />
          )}
        </div>

        {/* Location */}
        <details className="mb-2" ref={locationDetailsRef}>
          <summary className="text-xs text-slate-400 cursor-pointer select-none">
            Location
          </summary>
          <div className="mt-1">
            <div className="flex gap-2 mb-1">
              {(["none", "point", "area"] as LocationMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`px-2 py-0.5 text-xs rounded capitalize ${locationMode === m ? "bg-blue-600 text-white" : "bg-slate-700 text-slate-400"}`}
                  onClick={() => setLocationMode(m)}
                >
                  {m}
                </button>
              ))}
              {onStartMapPick && locationMode === "point" && (
                <button
                  type="button"
                  title="Pick location on map"
                  className="px-2 py-0.5 text-xs rounded bg-amber-700 hover:bg-amber-600 text-amber-100 transition"
                  onClick={() => onStartMapPick("point")}
                >
                  Pick
                </button>
              )}
              {onStartMapPick && locationMode === "area" && (
                <button
                  type="button"
                  title="Draw area on map"
                  className="px-2 py-0.5 text-xs rounded bg-amber-700 hover:bg-amber-600 text-amber-100 transition"
                  onClick={() => onStartMapPick("area")}
                >
                  Draw
                </button>
              )}
            </div>
            {locationMode === "point" && (
              <div className="grid grid-cols-2 gap-1">
                <input
                  type="number"
                  step="any"
                  className={inputClass}
                  value={lat}
                  onChange={(e) => setLat(e.target.value)}
                  placeholder="Latitude"
                />
                <input
                  type="number"
                  step="any"
                  className={inputClass}
                  value={lng}
                  onChange={(e) => setLng(e.target.value)}
                  placeholder="Longitude"
                />
              </div>
            )}
            {locationMode === "area" && (
              <div className="grid grid-cols-2 gap-1">
                <input
                  type="number"
                  step="any"
                  className={inputClass}
                  value={bboxNorth}
                  onChange={(e) => setBboxNorth(e.target.value)}
                  placeholder="North"
                />
                <input
                  type="number"
                  step="any"
                  className={inputClass}
                  value={bboxSouth}
                  onChange={(e) => setBboxSouth(e.target.value)}
                  placeholder="South"
                />
                <input
                  type="number"
                  step="any"
                  className={inputClass}
                  value={bboxEast}
                  onChange={(e) => setBboxEast(e.target.value)}
                  placeholder="East"
                />
                <input
                  type="number"
                  step="any"
                  className={inputClass}
                  value={bboxWest}
                  onChange={(e) => setBboxWest(e.target.value)}
                  placeholder="West"
                />
              </div>
            )}
          </div>
        </details>

        {/* Linked Aircraft */}
        <details className="mb-3">
          <summary className="text-xs text-slate-400 cursor-pointer select-none">
            Linked Aircraft
          </summary>
          <input
            type="text"
            className={`${inputClass} mt-1`}
            value={linkedHex}
            onChange={(e) => setLinkedHex(e.target.value)}
            placeholder="Hex idents, comma-separated (e.g., A1B2C3,D4E5F6)"
          />
        </details>

        {/* Actions */}
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded transition"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || !title.trim() || !description.trim()}
            className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded transition disabled:opacity-50"
          >
            {saving ? "Saving..." : isEdit ? "Update" : "Create"}
          </button>
        </div>
        </div>
      </form>
    </div>
  );
}
