/**
 * Switch for CopilotKit's developer inspector.
 *
 * CopilotKit only mounts the inspector in a development build on localhost or
 * 127.0.0.1, so a release build never has it. In `tauri dev` it does, and it
 * makes the app's only requests to third parties:
 * - news feeds from cdn.copilotkit.ai (`notifications/v1.json`,
 *   `inspector-hud/v1.json`): plain GETs with no credentials and no app data;
 * - its fonts from fonts.googleapis.com;
 * - promo videos (cdn.copilotkit.ai, loom.com) on its locked tabs.
 *
 * `NEXT_PUBLIC_COPILOTKIT_DISABLE_INSPECTOR=true` passes
 * `enableInspector={false}`, so the inspector is never mounted and none of
 * those requests happen. Default: unset, i.e. the inspector stays available.
 *
 * Next inlines `NEXT_PUBLIC_*` when it compiles, so set it in the environment
 * that starts `npm run tauri dev` (or in `.env.local`), then restart the app.
 */

const TRUTHY = new Set(["true", "1", "yes"]);

/** Parse the variable. Anything not clearly "on" keeps the default (false). */
export function isInspectorDisabled(raw: string | undefined): boolean {
  return TRUTHY.has((raw ?? "").trim().toLowerCase());
}

/** Whether to let CopilotKit mount its inspector (still dev + localhost only). */
// Literal `process.env.NEXT_PUBLIC_…` access: Next only inlines that form.
export const COPILOTKIT_INSPECTOR_ENABLED = !isInspectorDisabled(
  process.env.NEXT_PUBLIC_COPILOTKIT_DISABLE_INSPECTOR
);
