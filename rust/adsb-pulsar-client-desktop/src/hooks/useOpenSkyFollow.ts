"use client";
import { useCallback, useState } from "react";
import { selectionHex } from "@/lib/opensky";

export interface OpenSkyFollow {
  /** The aircraft followed through OpenSky, uppercase hex, in the order followed. */
  followed: string[];
  isFollowed: (key: string) => boolean;
  /** Follows, or stops following, the aircraft of a track key (live hex or osky: key). */
  toggle: (key: string) => void;
}

/**
 * The aircraft the user asked OpenSky to follow -- explicitly, from the details
 * panel or the track's context menu, never just by selecting it, so credits are
 * spent only on request. Session state. An aircraft known nowhere any more
 * (neither the receiver's tracks nor OpenSky's) is forgotten.
 */
export function useOpenSkyFollow(knownHexes: Iterable<string>): OpenSkyFollow {
  const [followed, setFollowed] = useState<string[]>([]);

  // Render-phase adjustment: an aircraft gone everywhere is no longer followed.
  const known = new Set(knownHexes);
  if (followed.some((h) => !known.has(h))) setFollowed(followed.filter((h) => known.has(h)));

  const toggle = useCallback((key: string) => {
    const hex = selectionHex(key);
    setFollowed((current) => (current.includes(hex) ? current.filter((h) => h !== hex) : [...current, hex]));
  }, []);
  const isFollowed = useCallback((key: string) => followed.includes(selectionHex(key)), [followed]);

  return { followed, isFollowed, toggle };
}
