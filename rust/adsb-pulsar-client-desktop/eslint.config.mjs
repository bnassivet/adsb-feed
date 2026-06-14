import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

const eslintConfig = [
  {
    ignores: [".next/**", "out/**", "node_modules/**", "src-tauri/**", "next-env.d.ts"],
  },
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    // eslint-config-next 16 bundles eslint-plugin-react-hooks v6, which enables
    // React-Compiler-readiness rules not enforced under Next 15. The genuine bugs it surfaced —
    // `react-hooks/refs` (ref access during render) and `react-hooks/immutability` (handler
    // self-reference / render mutation) — have been fixed and are enforced at error (not listed
    // here, so they inherit the preset's error level).
    //
    // The three rules below remain at "warn" because their remaining occurrences are legitimate
    // patterns, not bugs: data-fetching effects, async work, impure UUID minting on a transition,
    // animation intervals (set-state-in-effect); intentional render-time reads (purity); and
    // third-party hook integration such as CopilotKit (incompatible-library). Forcing these into
    // render would introduce bugs. The React Compiler safely bails out per-component on these, so
    // they do not affect correctness when the compiler is enabled.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/incompatible-library": "warn",
    },
  },
];

export default eslintConfig;
