import { useState, useEffect, useRef } from "react";
import { useMap } from "react-leaflet";

/**
 * Tracks the current Leaflet map zoom level with debouncing.
 *
 * Must be used inside a react-leaflet `<MapContainer>` child component.
 * Returns `Math.round(zoom)` so fractional zoom levels (from pinch gestures
 * or smooth zoom) are snapped to integers for H3 resolution mapping.
 */
export function useMapZoom(debounceMs: number = 300): number {
  const map = useMap();
  const [zoom, setZoom] = useState(() => Math.round(map.getZoom()));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function onZoomEnd() {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        setZoom(Math.round(map.getZoom()));
      }, debounceMs);
    }

    map.on("zoomend", onZoomEnd);
    return () => {
      map.off("zoomend", onZoomEnd);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [map, debounceMs]);

  return zoom;
}
