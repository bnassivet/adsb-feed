import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  // React Compiler (stable in Next 16) auto-memoizes components to cut re-renders. It uses Babel,
  // so builds are slower. Components that violate the Rules of React (the at-"warn" react-hooks
  // cases in eslint.config.mjs, and the AircraftTrackingContext ref-store) are safely skipped by
  // the compiler's own bailout — never miscompiled.
  reactCompiler: true,
};

export default nextConfig;
