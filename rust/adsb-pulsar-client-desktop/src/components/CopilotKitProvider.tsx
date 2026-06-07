"use client";
/**
 * Client-side wrapper for CopilotKit provider.
 * Separated from layout.tsx because the root layout is a Server Component.
 */
import { CopilotKit } from "@copilotkit/react-core/v2";
import type { ReactNode } from "react";

const AGENT_URL = "http://localhost:8000/ag-ui";

/** Agent id registered by the Python AG-UI runtime (must match its /info). */
export const AGENT_ID = "adsb_agent";

export function CopilotKitProvider({ children }: { children: ReactNode }) {
  return (
    <CopilotKit runtimeUrl={AGENT_URL} agent={AGENT_ID}>
      {children}
    </CopilotKit>
  );
}
