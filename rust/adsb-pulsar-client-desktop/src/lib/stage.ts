/**
 * The deployment stage this window belongs to.
 *
 * Shown as a badge in the top bar so two instances running side by side — a
 * dev stack and a client of the prod fleet — are never confused for each
 * other. Getting that wrong is expensive: the windows are identical, and
 * the mistake is only visible once you have acted on the wrong data.
 *
 * Derived from `source_id`, following the convention in `deploy/README.md`:
 *
 *     source_id = <host-or-site>-<stage>      e.g. dev-laptop-dev
 *
 * Not from `ADSB_STACK`, which names the *stack* rather than the stage and is
 * "default" for the unnamed one — the stage of the default stack is whatever
 * its `source_id` says, usually `dev`.
 */

/** Stages `make doctor` recognises. Keep in step with `scripts/stack.sh`. */
export const STAGES = ["dev", "prod", "staging", "test"] as const;

export type Stage = (typeof STAGES)[number];

/**
 * The stage named by a `source_id`, or `null` if it names none.
 *
 * `null` is not an error: a single-stack setup has no reason to carry a stage,
 * and `make doctor` already warns about it. The UI just shows no badge.
 */
export function stageOf(sourceId: string | null | undefined): Stage | null {
  if (!sourceId) return null;
  // Both separators are legal in a source_id, and only the LAST segment counts
  // -- "prod-box-dev" is a dev machine that happens to be called prod-box.
  const last = sourceId.trim().toLowerCase().split(/[-_]/).pop();
  return (STAGES as readonly string[]).includes(last ?? "")
    ? (last as Stage)
    : null;
}

/**
 * What to show in the top bar, given what the backend reports and the config.
 *
 * `stack` -- the validated `ADSB_STACK` the backend was launched with -- wins,
 * because it is the only one the stack config controls. `source_id` comes from
 * the app's OWN settings store, which a freshly-scoped stack starts empty: the
 * badge then fell back to the default id `kraspberryPi`, matched no stage, and
 * showed nothing at all.
 *
 * A stack name that is not a known stage is shown verbatim -- a window
 * belonging to a stack called `lab` should say so.
 */
export function resolveStage(
  stack: string | null | undefined,
  sourceId: string | null | undefined,
): string | null {
  const named = stack?.trim();
  // "default" is stack.sh's internal label for the unnamed stack; it is never
  // a badge. Defensive -- stack.sh sends "" -- but the two must agree.
  if (named && named.toLowerCase() !== "default") return named.toLowerCase();
  return stageOf(sourceId);
}
