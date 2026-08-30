/**
 * The deployment stage this window belongs to.
 *
 * Shown in the window title and the header so two instances running side by
 * side — a dev stack and a client of the prod fleet — are never confused for
 * each other. Getting that wrong is expensive: the windows are identical, and
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

/** `"ADS-B Aircraft Tracker [dev]"`, or the bare title when there is no stage. */
export function titleWithStage(title: string, stage: Stage | null): string {
  return stage ? `${title} [${stage}]` : title;
}
