/** Opens a track's context menu at a client (viewport) position. */
export type TrackMenuOpener = (key: string, x: number, y: number) => void;

/**
 * Props for a Leaflet line, dot or marker that selects a track when clicked
 * and, given `onContextMenu`, opens the track's menu on right-click.
 *
 * A Leaflet path passes its mouse events on to the map by default (a marker
 * does not), and the map's click handler deselects everything -- so without
 * `bubblingMouseEvents: false` a click selects and deselects in the same event,
 * and a right-click would open the map's menu as well as the track's.
 */
export function selectingPath(key: string, onSelect: (key: string) => void, onContextMenu?: TrackMenuOpener) {
  return {
    eventHandlers: {
      click: () => onSelect(key),
      // Absent rather than undefined: Leaflet warns on a listener that is not a function.
      ...(onContextMenu && {
        contextmenu: (e: { originalEvent: { clientX: number; clientY: number } }) =>
          onContextMenu(key, e.originalEvent.clientX, e.originalEvent.clientY),
      }),
    } as {
      click: () => void;
      contextmenu?: (e: { originalEvent: { clientX: number; clientY: number } }) => void;
    },
    bubblingMouseEvents: false as const,
  };
}
