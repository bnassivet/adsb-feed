"use client";
import dynamic from "next/dynamic";

// MapLibre touches `window` at import time.
const OcclusionProbe = dynamic(() => import("@/bench/OcclusionProbe").then((m) => m.OcclusionProbe), { ssr: false });

export default function Page() {
  return <OcclusionProbe />;
}
