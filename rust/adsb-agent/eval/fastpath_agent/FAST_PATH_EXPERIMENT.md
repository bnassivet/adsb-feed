# Desktop fast path: experiment record

Measured 2026-11-14 and 2026-11-15 on branch `feature/agent_optimizations`.
The fast path is now built into the agent service (`src/adsb_agent/fast_path.py`,
on by default, see `README.md`); the small model still runs server-side, not on
the desktop. This is the evidence it was built on.

## Result in short

Agent alone against agent with the fast path (`ministral-3-3b` executor,
embedding gate plus decision veto, rewritten descriptions), 273 requests:

| | Agent alone | With the fast path |
|---|---|---|
| Direct commands carried out exactly (of 60) | 57 | 58 |
| Wrong action shown on a direct command | 3 | 2 |
| Direct commands handled on the desktop | 0 | 42 |
| Time to the action, median | 3.83 s | 0.29 s |
| Wrong action shown on an agent request (of 213) | 0 | 0 |
| Time to the agent's first step on agent requests, mean | 7.52 s | 7.63 s |

The fast path does not make commands more correct; it makes about 70% of them
roughly ten times faster, at a cost of 0.1 s on every other request. Details in
"Agent alone against agent with the fast path" below.

**These figures do not hold on requests nobody tuned against.** On 176 fresh
requests the gate lets through 20% of the agent requests (0.5% here), and 7 of
95 agent requests end in a display change and "Done." instead of an answer. See
"Validation on fresh requests".

## Question

Can a direct display command ("hide the labels", "switch to night mode") be
carried out by a small local model on the desktop, without a round trip to the
main agent, and without the user ever seeing a wrong action?

Two components are needed, and each was measured separately and together:

1. A **gate** that decides whether a request is a direct command.
2. An **executor**, a small model that holds only the direct tools plus
   `handOffToAgent`, and makes the call.

A request the gate rejects, or the executor declines, goes to the main agent as
it does today. So a missed command only costs time; a wrong action is the harm.

## Setup

| Element | Value |
|---|---|
| Requests | 273 (dataset `adsb-tool-selection-v6`, from `../data/labels.jsonl`) |
| Direct commands among them | 60 (`route = desktop`); 213 belong to the agent |
| Direct tools | 15 (`eval_route.DIRECT_TOOLS`) |
| Argument check | values compared with `expected_calls` (`call_matching.py`) |
| Embedding model | `embeddinggemma-300m` |
| Decision model | `d1-omni-600m` (typesafe `systemone` API through the MLflow gateway) |
| Main agent model | `gemma-4-12b-qat` |
| Executors | LM Studio, reasoning off; `apple_fm` through the MLflow gateway |
| Tracking | MLflow experiment `adsb-agent-tool-ranking` at `http://127.0.0.1:5010` |

Labels (routes, expected calls) were drafted by the assistant and have not been
reviewed line by line.

### Tool descriptions

Two sets are compared:

- **Original**: what the desktop sends today (`../fixtures/tool_surface.json`).
- **Rewritten**: `fixtures/tool_overrides_v2.json`, applied over the original
  when `ADSB_EVAL_TOOL_OVERRIDES` names the file. Each of the 15 direct tools
  opens with "Display command:", lists the phrasings users type with the
  argument they map to, and says it only changes the display.

The rewrite is an evaluation overlay. `useCopilotTools.ts` is unchanged.

## Gates

Thresholds are cross-fitted for 95% precision: fitted on one half of the
requests, applied to the other. Figures are the median over 25 different
half/half splits (worst split in brackets).

| Gate | Descriptions | Precision | Recall |
|---|---|---|---|
| Embedding margin (best direct tool minus best other tool) | original | 93% (84%) | 53% |
| Embedding margin | rewritten | 94% (89%) | 80% |
| Decision model, old single question | either | 87% (75%) | 17% |
| Decision model, new: P(display command) | rewritten | 90% (77%) | 32% |
| Decision model, new: command x family x tool | rewritten | 90% (74%) | 23% |
| Embedding margin, then decision veto | original | 100% (92%) | 47% |
| Embedding margin, then decision veto | rewritten | 98% (96%) | 70% |

The veto drops a request when the decision model gives "display command" a
probability under 0.5. That value is not fitted.

On the default split, with the rewritten descriptions:

- Embedding gate: 48 of 60 commands pass, 5 agent requests pass wrongly.
- With the veto: 42 commands pass, 1 agent request passes wrongly.
- Removed by the veto: "which map theme and mode is the app in?", "show it on
  the map", "show history tracks today between 12pm and 2pm", "pan to the
  selected aircraft". Still passing: "What filter can you act on?".
- Commands the veto costs: "set wind display level to FL300", "show the canned
  demo routes", "please start the ADS-B feed again", "select aircraft 4CA7B2",
  "color the tracks by altitude", "pause data acquisition, stop the ADS-B feed".

## The decision-model wording

`decision_gate.py`. One request carries six independent `choice` questions
(about 100 ms and 970 input tokens):

| Question | Options |
|---|---|
| `kind` | display command, question, simulation, other |
| `route` | four families of display commands, plus question, simulation, other |
| `tool:<family>` (four of them) | the tools of that family, each with its **full** description |

The code takes the family from `route` and reads only that family's tool answer.
Families hold three or four tools because one question must fit in 512 tokens;
fifteen full descriptions do not.

What was tried on `d1-omni-600m` and dropped:

- **Yes/no (`noul`) questions.** "Is the message a question?" scored between
  0.00 and 0.30 on "what is the wind at FL350?". One yes/no per tool, carrying
  its description, ranked unrelated tools first. The same judgement expressed as
  a `choice` between described options separated commands from questions well.
- **A "none of these" option.** It competes with the real options; the `kind`
  question says whether any command applies.
- **The request as a nested object.** A plain string as `state` gave cleaner
  answers than `{"inputs": {"question": ...}}`.
- **Choice confidence as a signal.** It is `(p_max - 1/n) / (1 - 1/n)`, a
  rescaled top probability, so the probability is thresholded directly.

The tool the decision model names is an expected one for 32 of 60 commands (33
with the original descriptions). It is not good enough to hand the executor a
single tool.

## Executors

Each model saw all 273 requests once; no tool was executed. Cells are
**commands done exactly right / wrong actions shown**, out of 273 requests,
behind the gate named in the column.

| Executor | Original, embedding gate | Rewritten, embedding gate | Rewritten, embedding gate + veto | Median latency |
|---|---|---|---|---|
| `ministral-3-3b` | 24 / 10 | 46 / 6 | 40 / 2 | 0.29 s |
| `gemma-4-e4b` | 31 / 1 | 45 / 5 | 40 / 2 | 0.64 s |
| `gemma-4-e2b` | 30 / 2 | 44 / 6 | 38 / 4 | 0.41 s |
| `lfm3-omni-2b` | 28 / 5 | 38 / 13 | 33 / 9 | 0.30 s |
| `apple_fm` | 23 / 10 | 32 / 16 | 27 / 15 | 1.08 s |
| `lfm2.5-1.2b` | 18 / 12 | 25 / 25 | 21 / 20 | 0.26 s |

Without any gate, with the rewritten descriptions:

| Executor | Direct commands exactly right (of 60) | Agent requests it acted on (of 213) |
|---|---|---|
| `ministral-3-3b` | 56 | 37 |
| `lfm3-omni-2b` | 50 | 117 |
| `apple_fm` | 38 | 9 |
| `lfm2.5-1.2b` | 30 | 45 |

No executor is safe as its own gate.

Model-specific handling:

- `ministral-3-3b`: `--history-style alternate`. Its chat template rejects two
  user messages in a row (HTTP 500), which first looked like a weak model.
- `apple_fm`: `--call-style json --reasoning-effort default`. It emits no tool
  calls, so two schema-constrained replies are used (pick the tool, fill its
  arguments). `"stream": false` must be sent explicitly.
- `gemma-4-e2b`, `gemma-4-e4b`: reasoning must be off, or the reply is empty.

## Main agent with the rewritten descriptions

The descriptions are shared with the main agent, so its first tool call was
measured on all 273 requests (`eval_agent_step.py --mode full
--context-placement user`). Every request got a reply in both runs.

| First tool call is a needed one | Original | Rewritten |
|---|---|---|
| All 273 | 235 | 233 |
| 60 direct commands | 60 | 59 |
| Input tokens per request, mean | 7,091 | 7,768 |

Ten requests change verdict, four for the better and six for the worse, mostly
on tools whose description did not change. No measurable effect on tool choice;
about 680 more tokens per turn. Argument correctness of the main agent with the
rewritten descriptions was not measured.

## Agent alone against agent with the fast path (2026-11-15)

`eval_fast_path_compare.py`. The main agent was rerun on all 273 requests with
no fast path (original descriptions, what runs today), and its first reply to
each direct command was judged exactly like an executor's: same tool, same
argument values. The fast path column is gate, then executor, then the agent
for whatever the executor did not carry out, with their times added up.

Executor `ministral-3-3b`, rewritten descriptions:

| | Agent alone | Fast path, embedding gate + veto | Fast path, embedding gate |
|---|---|---|---|
| **60 direct commands** | | | |
| Carried out exactly | 57 | 58 | 58 |
| Wrong action shown | 3 | 2 | 2 |
| Handled on the desktop | 0 | 42 | 48 |
| Time to the action, median | 3.83 s | 0.29 s | 0.17 s |
| Time to the action, mean | 4.68 s | 1.50 s | 1.10 s |
| **213 agent requests** | | | |
| Wrong action shown instead of an answer | 0 | 0 | 4 |
| Time to the agent's first step, mean | 7.52 s | 7.63 s | 7.37 s |

With `gemma-4-e4b` as executor: 58 exact / 2 wrong / 0 wrong on agent requests
with the veto (median 0.41 s); 57 / 3 / 2 without it.

Veto threshold (`--veto-below`, `ministral-3-3b`, same run):

| Drop when P(display command) is under | Commands passing the gate | Agent requests passing | Exact / wrong on the 60 commands | Median time to the action |
|---|---|---|---|---|
| 0.5 | 42 | 1 | 58 / 2 | 0.29 s |
| 0.75 | 36 | 1 | 57 / 3 | 0.34 s |
| 0.9 | 30 | 0 | 57 / 3 | 1.16 s |

Raising the threshold only gives up commands: the one agent request that still
passes at 0.5 ("What filter can you act on?") also passes at 0.75, and the
executor declines it in every case. 0.5 is the better setting on this data.

- **Correctness is a tie; the gain is time.** The agent alone already carries
  out 57 of 60 commands. The fast path does not make commands more correct. It
  makes 42 to 48 of them about ten times faster to act.
- **The veto is what keeps agent requests unharmed**: 0 wrong actions against 4
  (2 with `gemma-4-e4b`), for about 0.1 s added to every request.
- The fast path fixes three commands the agent gets wrong ("hide the sidebar",
  "show all events on the map, no time filter", "connect to the receiver and
  start receiving data") and breaks two it gets right ("show the density heatmap
  for aircraft below 10000 ft only", "Activate history filter.").
- The agent's time is to its first tool call only. It then makes a second model
  call to write its reply, which the fast path does not need, so the real gap is
  larger. The embedding gate's own time is not included (embeddings were cached
  in this run); the decision request is (about 0.1 s).
- **Noise floor, measured.** Two identical agent-alone runs disagreed on the
  first tool for 10 of 271 requests (235 and 231 of 273 with a needed first
  tool). A difference of that size between two configurations means nothing;
  the 235 against 233 for the rewritten descriptions is inside it.

```bash
uv run python eval/eval_agent_step.py --mode full --context-placement user
ADSB_EVAL_TOOL_OVERRIDES=eval/fastpath_agent/fixtures/tool_overrides_v2.json \
    uv run python eval/fastpath_agent/eval_fast_path_compare.py --executor mistralai_ministral-3-3b --gate embed+veto
```

## The service's own code path (2026-11-15)

`eval_fast_path_service.py` calls `fast_path.try_fast_path`, the function behind
the agent endpoint, on all 273 requests: packaged descriptions, **fixed** gate
threshold 0.0605 (fitted on all requests for 95% precision, not cross-fitted),
veto, `ministral-3-3b`, validation of the calls.

| | Agent alone | Service, veto on | Service, veto off |
|---|---|---|---|
| Direct commands handled by the fast path (of 60) | 0 | 42 | 48 |
| Carried out exactly | 57 | 57 | 57 |
| Wrong action shown on a direct command | 3 | 3 | 3 |
| Time to the action, median | 3.83 s | 0.27 s | 0.19 s |
| Wrong action shown on an agent request (of 213) | 0 | 0 | 1 |

Where requests stop, veto on: direct commands 42 handled, 12 rejected by the
gate, 6 vetoed; agent requests 212 rejected by the gate, 1 vetoed. The times
include the embedding request and the decision request.

It matches the joined-results figures within one command. The three wrong
actions it shows: a history depth set to 24 hours for "Activate history filter.",
an unrequested `metric` on the density command, and a misspelled request
answered with the history layer instead of a history window.

## Validation on fresh requests (2026-11-15)

`data/validation_labels.jsonl`, 176 requests: 21 mined from the agent's traces
after the main set was labelled (voice transcripts, verbatim) and 155 written
before their author had read the packaged descriptions or the main set's
questions. 81 direct commands, 95 agent requests. Nothing was changed after
seeing the results. How it was built and how to run it: `eval/README.md`.

The same service code path, fixed threshold 0.0605, veto on, `ministral-3-3b`:

| | Main set (273) | Fresh requests (176) |
|---|---|---|
| Commands passing the embedding gate | 48 of 60 (80%) | 50 of 81 (62%) |
| Agent requests passing the embedding gate | 1 of 213 (0.5%) | 19 of 95 (20%) |
| Gate separation (AUC of the margin) | 0.99 | 0.80 |
| Commands handled by the fast path | 42 (70%) | 45 (56%) |
| ... of those, carried out exactly | 39 | 41 |
| Agent requests answered with an action | 0 | 7 |

What the user ends up with on the fresh requests, the agent finishing whatever
the fast path leaves:

| | Agent alone | Veto on | Veto off |
|---|---|---|---|
| Commands carried out exactly (of 81) | 69 | 69 | 68 |
| Wrong action shown on a command | 8 | 10 | 11 |
| Time to the action, median | 5.17 s | 0.40 s | 0.32 s |
| Wrong action shown on an agent request (of 95) | 0 | 7 | 10 |

- **The gate is what failed.** The 19 agent requests that pass it: 13 of the 22
  `near_tool` requests (a question or remark about something a direct tool
  controls), 2 trace requests, 2 chat, 1 mixed, 1 follow-up. None of the 46
  ordinary questions, lookups, edits and simulations pass. Without the
  `near_tool` requests the AUC is 0.89, still well under the main set's.
- **No threshold repairs it.** At 0.13 the gate still passes 6 agent requests
  and only 37% of the commands. The margins overlap: agent requests reach 0.21,
  the median command sits at 0.084.
- **The veto still earns its place, but it is not enough.** It stops 9 of the 19;
  the executor would have acted on 3 of those ("is the sidebar open?" closes the
  sidebar, "don't stop the feed" stops it). It costs 5 commands, 3 of which the
  executor had right. The executor's hand-off stops 3 more.
- The 7 that get through: "which mode am I in?" (switches to live), "should I
  use dark mode at night?" (switches to dark), "can you hide layers?" (hides the
  positions), "the labels are too cluttered" (hides them; the agent alone does
  the same, so count this one as you see fit), "show the last 6 hours of history
  and summarise the traffic" (sets the window, never summarises), and two
  garbled voice follow-ups.
- Wrong actions on commands: "Switch to Delight mode." (voice for daylight) set
  the dark theme, "set history depth to two days" gave 24 hours, and two density
  commands got `setDensityConfig(metric: aircraft)` nobody asked for.
- The 21 trace requests alone: of 11 commands, 5 pass the gate, 3 are carried
  out exactly, 1 wrongly; of 10 agent requests, 2 are acted on. Short voice
  commands in a conversation ("Disconnect.", "Okay, connect.") are rejected:
  the gate embeds the earlier turns with the request.
- Recall is lower for a reason the main set hides: its commands were mostly
  phrased the way the descriptions now list them.

Read with care:

- The mix is harder than the main set on purpose (22 of 95 agent requests are
  `near_tool`). Compare the rates per class, not precision.
- The "agent alone" column judges the first reply only, with a sample UI state.
  Several of its 8 "wrong" are first steps or correct refusals ("Aircraft labels
  are already visible"), so it understates the agent. Its median is 5.17 s here
  against 3.83 s on the main set, measured on a different day's load.
- One author wrote 155 of the requests and all the labels; nobody else has
  reviewed them. Agent requests have no tool labels.
- This set is now spent as a blind test for anything changed because of it.

## Gate fixes (2026-11-18)

Development data: the main set and the (now spent) validation set, 449
requests, 141 commands. Blind test: `data/holdout_labels.jsonl`, written before
any of this was tried (see `eval/README.md`).

**Embedding variants** (`eval_gate_variants.py`), AUC of the margin:

| Variant | All | Main | Validation |
|---|---|---|---|
| A shipped: request with its earlier turns | 0.924 | 0.989 | 0.798 |
| B the latest message alone | 0.915 | 0.986 | 0.786 |
| C A + one "asking about ..." document per direct tool | 0.933 | 0.987 | 0.847 |
| D B + C | 0.928 | 0.986 | 0.837 |

- Dropping the earlier turns does not help: the questions that pass have no
  history. Not adopted.
- The "asking about" documents (`fixtures/about_descriptions.json`) help a
  little: at 60% of commands kept, 10 agent requests pass instead of 13.
  "should I use dark mode at night?" still scores +0.13: a question and a
  command about the dark theme share their topic, and that is all an embedding
  sees. Not adopted.

**Question-form check** (`fast_path.reads_as_question`, adopted): a message
that starts with a question word or an auxiliary, ends with "?", or opens with
a negation goes to the agent with no model call.

| At ~60% of commands kept (development) | Agent requests passing |
|---|---|
| A | 13 |
| C | 10 |
| A + question-form check | 1 |

At the shipped threshold (0.0605) it takes the agent requests passing the gate
from 20 to 5 of 308 and costs 1 of 141 commands ("can you go back to the light
theme": polite commands go to the agent, slower but never wrong). The 5 left are
imperatives that need a lookup or carry a second request ("pan to the selected
aircraft", "show the last 6 hours of history and summarise the traffic"), which
is what the veto is for.

The service's own path, `ministral-3-3b`, **veto off** (the decision model
endpoint was unreachable on 2026-11-18; the gateway's `d1-omni-600m` now maps to
an OpenAI-style backend and answers 422):

| Validation set | No check | Check |
|---|---|---|
| Wrong action on an agent request (of 95) | 10 | 3 |
| Commands carried out exactly (of 81) | 68 | 68 |
| Commands handled fast | 50 | 49 |

On the main set the check changes nothing on the 60 commands and stops 88 of
the 213 agent requests before the embedding call.

Read with care: the regex was written after seeing the validation failures, and
the same author wrote the holdout, whose `near_tool` requests are mostly
phrased as questions. The holdout's `remark` and negation requests ("Leave the
sidebar alone.", "Please don't disconnect") are the ones the check cannot see.

### Holdout reading (2026-11-18, once, nothing changed after)

`holdout_labels.jsonl`, 137 requests (54 commands, 83 agent requests, 59 of
them `near_tool`). The service's path as committed, `ministral-3-3b`, threshold
0.0605, **veto off** (decision model unreachable). Agent alone:
`gemma-4-12b-qat`, all 137 answered.

| | Agent alone | No check | Check |
|---|---|---|---|
| Wrong action on an agent request (of 83) | 0 | 16 | **4** |
| Commands carried out exactly (of 54) | 45 | 45 | 45 |
| Wrong action on a command | 8 | 9 | 9 |
| Commands handled by the fast path | 0 | 24 | 24 |
| Time to the action, median | 5.11 s | 3.31 s | 3.31 s |

- **The embedding gate is near chance here: AUC 0.59** (main 0.99, validation
  0.80). It passes 30 of 83 agent requests and only 24 of 54 commands (44%;
  validation 62%, main 80%). Each new set phrased away from the descriptions
  costs it more.
- The check holds: 12 of the 16 wrong actions are stopped, no command lost.
- The 4 left are what it cannot see, as expected: two remarks ("I prefer the
  light map, just so you know.", "That heatmap looks great."), a negation not
  at the start ("Leave the sidebar alone."), and a mixed request.
- The speed gain shrinks with recall: the median command now waits 3.3 s, not
  0.3 s, because most commands miss the gate and pay for the agent anyway.
- Follow-ups: "Now the other one." (after "Go to live mode.") went to live,
  "Same for the trails." also hid the labels. The executor reads the history
  but gets the reference wrong.
- Veto on, measured later the same day once the decision model answered again
  (`typesafe` / `d1-omni-600m`, as on 2026-11-15), nothing else changed:

  | Veto on, check on | Main | Validation | Holdout |
  |---|---|---|---|
  | Wrong action on an agent request | 0 of 213 | 3 of 95 | **1 of 83** |
  | Commands carried out exactly (agent alone) | 57 (59) | 69 (69) | 45 (45) |
  | Commands handled by the fast path | 42 of 60 | 44 of 81 | 20 of 54 |
  | Time to the action, median (agent alone) | 0.32 s (3.76) | 0.40 s (5.17) | 3.78 s (5.11) |

  On the holdout the veto stops the two remarks and "Leave the sidebar alone.";
  the one left is a mixed request ("Show the density layer and tell me where
  the hotspot is." shows the layer, never answers). It also costs 4 commands
  (24 -> 20 handled). On validation it stops none of the 3 the check left
  ("the labels are too cluttered" scores 0.81 as a command). The main set
  reproduces the 2026-11-15 figure (42 handled, 0 wrong).
- Same author for the holdout and the check, and the holdout's `near_tool`
  requests are mostly questions: the 16 -> 4 flatters the check.

## Findings

1. **The fast path buys time, not correctness.** The agent alone carries out 57
   of 60 direct commands exactly; with the fast path it is 58. The median time
   to the action drops from 3.83 s to 0.29 s for the commands handled locally.
2. Rewriting the descriptions is what moved the gate: recall 53% to 80% at the
   same precision.
3. The same rewrite roughly doubles what `ministral-3-3b` gets right, because
   its failure was omitted arguments and the descriptions now show them.
4. The decision model is a weak gate alone and a poor tool picker, but a good
   veto: it catches requests that match a tool by topic and are not
   self-contained commands. With it, no agent request ends in a wrong action
   (4 without it).
5. Best measured configuration: embedding gate, decision veto, `ministral-3-3b`
   (or `gemma-4-e4b`, same results, 0.41 s). 42 of 60 commands are handled on
   the desktop and the agent finishes the rest.
6. The main agent gains nothing from the rewritten descriptions; the difference
   measured is inside the run-to-run noise (10 of 271 first tool calls).
7. **The gate overfitted the main set.** Its separation falls from an AUC of
   0.99 to 0.80 on fresh requests, and questions about what a direct tool
   controls pass it more often than not. The speed gain holds (0.40 s against
   5.17 s for the 56% of commands handled); the "no wrong action on an agent
   request" result does not.

## Limits

- **The numbers are optimistic for new requests**, and "Validation on fresh
  requests" says by how much. The descriptions were written from failures in
  half of the requests, the held-out half has since been read, and the veto
  design was chosen after looking at all 273.
- With 60 direct commands, counts move by a few between splits.
- The gate threshold is refitted on every run, so rewording one tool changes
  which other requests pass.
- Instructions such as "set ONLY the fields the user mentions" partly overfit:
  they removed unrequested extras in one half and caused omissions in the other.
- Single runs at temperature 0. Two identical agent runs differ on about 10 of
  271 first tool calls; the executors were run once each.
- The broader scope (all 25 UI action tools, scenario and event edits included)
  was tried earlier and rejected: those commands need ids looked up first.

## Reproduce

Run from `rust/adsb-agent` (not from `eval/`, or `.env` is not loaded).

```bash
export ADSB_EVAL_TOOL_OVERRIDES=eval/fastpath_agent/fixtures/tool_overrides_v2.json   # omit for the original descriptions

uv run python eval/fastpath_agent/eval_route.py                       # gates: old decision question, embedding, both
uv run python eval/fastpath_agent/eval_executor.py --model google/gemma-4-e4b
uv run python eval/fastpath_agent/eval_executor.py --model google/gemma-4-e2b
uv run python eval/fastpath_agent/eval_executor.py --model lfm3-omni-2b
uv run python eval/fastpath_agent/eval_executor.py --model liquid/lfm2.5-1.2b
uv run python eval/fastpath_agent/eval_executor.py --model mistralai/ministral-3-3b --history-style alternate
uv run python eval/fastpath_agent/eval_executor.py --model apple_fm \
    --base-url http://localhost:5010/gateway/mlflow/v1 --call-style json --reasoning-effort default

uv run python eval/fastpath_agent/eval_decision_gate.py               # new decision wording, veto, and both gates
                                                       # re-applied to the executor files in results/
uv run python eval/eval_agent_step.py --mode full --context-placement user   # main agent, about 30 minutes
```

Per-record results are written to `eval/results/` (not committed). Tests for the
decision gate: `tests/fastpath_agent/test_eval_decision_gate.py`; all of this
experiment's tests and the service's are in `tests/fastpath_agent/`.

## Files

Paths relative to this folder, `eval/fastpath_agent/`. Everything here belongs
to this experiment; what it shares with the other evaluations is one level up.

| File | Role |
|---|---|
| `eval_route.py` | gates, cross-fitting, `DIRECT_TOOLS` |
| `eval_executor.py` | executor outcomes, alone and behind the embedding gate |
| `decision_gate.py` | the six-question decision request and its signals |
| `eval_decision_gate.py` | decision gate, veto, pipeline per executor |
| `eval_fast_path_compare.py` | agent alone against agent with the fast path |
| `eval_fast_path_service.py` | the service's `try_fast_path` on every request; `--fit` refits the gate threshold |
| `eval_gate_variants.py` | embedding-gate variants (no earlier turns, "asking about" documents); `--holdout` |
| `call_matching.py` | expected-argument matching |
| `data/validation_labels.jsonl` | 176 fresh requests (spent), selected with `ADSB_EVAL_LABELS` |
| `data/holdout_labels.jsonl` | 137 requests, the blind test of the gate fixes (spent) |
| `fixtures/tool_overrides_v1.json`, `tool_overrides_v2.json` | rewritten descriptions |
| `fixtures/about_descriptions.json` | "asking about" documents, gate variant C |
| `../eval_agent_step.py` | main agent's first tool call (shared) |
| `../common.py` | applies the overlay (`ADSB_EVAL_TOOL_OVERRIDES`) and `ADSB_EVAL_LABELS` (shared) |
| `../data/labels.jsonl` | the main set (shared) |
| `../../src/adsb_agent/fast_path.py` | the fast path itself; the eval scripts import its constants |

## Open points

- Built, on by default, veto on (decided 2026-11-15). Both are parameters.
- The small model runs in the agent service. Moving it to the desktop is not done.
- The rewritten descriptions are packaged with the service for the gate and the
  executor only; `useCopilotTools.ts` and the main agent's prompt are unchanged.
- Validated on fresh requests (2026-11-15): it acts on 7 of 95 agent requests.
  Kept on by default (decided 2026-11-18).
- Question-form check added (2026-11-18). On the holdout: 4 wrong actions in
  83 agent requests with the veto off (16 without the check), 1 with the veto
  on. The gate is at AUC 0.59 there and passes 44% of commands, so most
  commands still wait for the agent.
- Tried and not adopted: "asking about" documents, embedding without the
  earlier turns. Not tried: a veto question about whether the message asks for
  a change at all; the remaining misses are remarks, which that targets.
- The holdout is spent. A next gate change needs new requests again.
- The fast path depends on the gateway's `d1-omni-600m` keeping its `typesafe`
  provider. On 2026-11-18 it was briefly mapped to an OpenAI-style backend and
  answered 422; every request passing the gate then ended in `error` and the
  fast path handled nothing, silently. Watch
  `adsb_agent_fast_path_decisions_total{outcome="error"}`.
- Have someone other than their author review the validation labels.
