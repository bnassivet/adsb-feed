"use client";
/**
 * Client-side wrapper for CopilotKit provider.
 * Separated from layout.tsx because the root layout is a Server Component.
 */
import { CopilotKit } from "@copilotkit/react-core/v2";
import type { ReactNode } from "react";
import { AGENT_AG_UI_URL } from "@/lib/agent-url";
import { COPILOTKIT_INSPECTOR_ENABLED } from "@/lib/copilotkit-inspector";

/** Agent id registered by the Python AG-UI runtime (must match its /info). */
export const AGENT_ID = "adsb_agent";

export function CopilotKitProvider({ children }: { children: ReactNode }) {
  return (
    // enableInspector: NEXT_PUBLIC_COPILOTKIT_DISABLE_INSPECTOR, see
    // lib/copilotkit-inspector.ts. Off stops its third-party requests in dev.
    <CopilotKit
      runtimeUrl={AGENT_AG_UI_URL}
      agent={AGENT_ID}
      enableInspector={COPILOTKIT_INSPECTOR_ENABLED}
    >
      {children}
    </CopilotKit>
  );
}
