import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  // Build output directory. Overridable because Next 16 allows only ONE dev
  // server per dist dir -- it holds a flock on `<distDir>/dev/lock` and refuses
  // to start a second whatever port you give it. Running the desktop app
  // against two stacks at once therefore needs a dist dir per stack, which is
  // required anyway: two dev servers sharing one `.next` would fight over the
  // same build output. scripts/stack.sh sets this for named stacks.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
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
