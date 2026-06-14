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
    // React-Compiler-readiness rules that were NOT enforced under Next 15. They flag
    // pre-existing patterns across ~18 files (reading refs during render, set-state in
    // effects, etc.). Demoted to warnings to keep CI green while preserving the prior
    // lint baseline; tracked as follow-up debt to make the app React-Compiler-clean.
    rules: {
      "react-hooks/refs": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/incompatible-library": "warn",
    },
  },
];

export default eslintConfig;
