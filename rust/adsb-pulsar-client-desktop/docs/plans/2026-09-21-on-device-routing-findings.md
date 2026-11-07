# On-device model routing — measurements against the official Cactus engines

*2026-09-21, rewritten 2026-09-22 to lead with the official engines.
Branch `feature/local-model-routing`.*

## What was being built

A second, orthogonal split to the existing tool-plane split in `adsb-agent`'s
`graph.py`: a **model plane**. Cheap view commands ("switch to dark mode", "hide
the sidebar") would be answered by Cactus Needle 3 running on-device, with no
network hop and no dependency on the Python agent; anything else escalates to
the LangGraph ReAct loop exactly as before.

The decision layer, the guards, the registry and the executor are built, tested
and committed. Nothing is wired into the chat: the feature is dark, and the
reason is **accuracy, not speed** — see the recommendation.

**Read the recommendation before the accuracy section.** The accuracy numbers
here were measured against a twelve-tool catalog, which Cactus's tool-design
guide explicitly says not to do; correcting that changes them substantially.

## What was measured

Everything below is the **official Cactus artefacts**, from
`huggingface.co/Cactus-Compute/needle3`. The repo ships **21 platform folders**,
each engine under 1 MB, all loading the same container.

| role | artefact | bytes | sha256 (first 12) |
|---|---|---|---|
| weights | `needle3.cact` | 35 335 380 | `c9d915eca282` |
| native engine | `macos-arm64/needle` (CLI runner) | 824 744 | `bfcc14c38a7e` |
| WASM engine | `wasm/needle.wasm` | 688 521 | `77c6a38cacb8` |
| WASM glue | `wasm/needle.js` (Emscripten, UMD) | 62 502 | `d00ec67ec7e0` |

Also present and **not** used: `macos-arm64/libneedle.a` (1 158 184 B, for
linking into `src-tauri` instead of spawning the CLI) and
`wasm-component/needle.component.wasm` (4 173 594 B, WASI).

Host: Apple **M4 Max** (12 P + 4 E cores), macOS 26.6.2, Node 24.7.0.
Catalog: the twelve routable tools, `rust/adsb-needle/tests/fixtures/catalog.json`,
4 289 chars → **1 032 prompt tokens**. Fourteen utterances, ten actionable and
four that must escalate. Gate: confidence ≥ 0.85 **and** empty
`validation.ungrounded`.

## Latency

`needle_init` tokenizes and prefills the tool catalog **once**; `needle_complete`
then pays only the utterance. Startup and per-turn are therefore separate costs
and must not be added together.

| | startup (once) | **per turn** | prefill | decode |
|---|---|---|---|---|
| **official native** (`--serve`) | ~350 ms | **50 ms** | 2 390 tok/s | 1 320 tok/s |
| **official WASM** | load 18 ms + init **4 186 ms** | **402 ms** | 184 tok/s | 168 tok/s |

Both rows are **deterministic**: repeated runs reproduce every confidence to
three decimals. `prefill`/`decode` are the engine's own `prefill_tps` /
`decode_tps` fields, not wall-clock estimates. Peak RAM, native: ~105 MB.

Three points the numbers turn on:

- **The native CLI's one-shot mode is not a per-turn cost.** `bench-official.sh`
  spawns a process, loads 35 MB and re-runs `needle_init` on *every* invocation;
  that is the 355 ms/turn it reports. An empty-catalog run finishes in 20–30 ms
  total, so ~315 ms of it is catalog init being redone. **Steady state, with the
  catalog already tokenized, is 50 ms.** An earlier revision of this document
  quoted the one-shot figure (362 ms) as if it were per-turn; it is not.
- **WASM is single-threaded, and that is most of the 8x gap.** `needle.wasm`
  declares **unshared memory** (memory section flags `0x01`), so no pthreads;
  the native CLI defaults to `--threads` = fast cores capped at 4. The
  compensation is real: unshared memory means **no COOP/COEP cross-origin
  isolation** is needed in the Tauri webview.
- **WASM's 4.2 s startup is the only significant WASM cost**, and it is exactly
  1 032 tokens at 184 tok/s — the static prefix, as the C API advertises. It
  belongs in a Worker at app launch, off the critical path. `--tool-index`
  persists those embeddings and should reduce it; not measured.

### The C API, which is why this shape works

```c
needle_init(system_prompt, tools_json, tool_index_path)  /* -> prefix tokens */
needle_complete(input, max_new_tokens, out, out_capacity)
```

The catalog is a **static prefix**, paid at init. This is what makes a
twelve-tool catalog affordable, and it removes the entire premise of the
catalog-narrowing work recorded in the appendix.

## Accuracy, and why the feature is parked

| | correct | false-local |
|---|---|---|
| official native | 7/14 | 2 |
| official WASM | **8/14** | **3** |

**The two official builds disagree, and neither is noisy** — both are
deterministic. WASM returns `setDensityConfig` at **1.000** for *"show the
density heatmap"* where native abstains at **0.071**; it scores *"how many
flights did we record last Tuesday?"* 0.490 against native's 0.768. So
**confidence does not port across builds of the same engine on the same
weights.** Any threshold is per-target and must be re-derived per target.

What both builds agree on is the failure that matters:

```
0.98x  setActiveMode{mode:"live"}        <- "switch to dark mode"
1.000  toggleDemoFlights{enabled:false}  <- "delete the scenario called approach test"
0.966  selectAircraft{hexIdent:"#FF0000"} <- "generate a helicopter orbiting the port"
```

Only the third is catchable: the engine's own `validation.ungrounded` names
`select_aircraft.hex_ident` as an argument it cannot find in the query, and our
`selectAircraft` guard rejects it independently. **The first two are invisible to
every signal available** — `suppressed_calls` empty, `validation` clean,
confidence 1.000. A request to *delete a scenario* confidently toggles a map
layer off.

Two hypotheses tested and rejected: `--tool-index` is an embedding cache and
changes no answers; renaming the catalog to snake_case changes nothing (the
engine normalises internally — hence `select_aircraft.hex_ident` in its own
output).

### The accuracy measurement was misconfigured (2026-09-22)

Every accuracy number above ran a **twelve-tool** catalog. Cactus's tool-design
guide says not to:

> Keep toolsets to **five or fewer** tools for direct rendering. Above that,
> retrieval engages: every schema is embedded once, each request is embedded, and
> only the **five closest** tools enter the context. […] Unselected tools become
> unreachable, risking misrouting.

So the model never saw twelve tools. It saw five retrieved ones, and where the
right tool was not retrieved it chose confidently from what it had. Measured,
same engine, same utterances, only the catalog size changed:

| utterance | 12 tools | 5 tools |
|---|---|---|
| "switch to dark mode" | `setActiveMode` 0.981 ✗ | **`setMapTheme` 0.993** ✓ |
| "hide the sidebar" | `toggleSidebar` 1.000 ✓ | `toggleSidebar` 0.988 ✓ |
| "switch to analysis mode" | `setActiveMode` 0.984 ✓ | `setActiveMode` 0.991 ✓ |
| "show the density heatmap" | *abstain* 0.071 ✗ | **`setLayerVisibility` 0.874** ✓ |
| "turn on the wind barbs" | `setWeatherLayer` 0.655 (gated) ✗ | **`setWeatherLayer` 0.965** ✓ |

**3/5 → 5/5, every one above the gate.** And the worst false-local goes with it:
*"delete the scenario called approach test"* scores `toggleDemoFlights` at
**1.000** against twelve tools and **abstains at 0.580** against five, because
that tool is no longer in the window.

This also retro-explains the narrowing table in the appendix, which was filed
under latency: 12 tools 5/14 → 4 tools 6/14 → 3 tools 7/14 → 1 tool 8/14, with
the knee at the documented threshold. It was never only a latency lever.

### Lexical poisoning is real, and worth one rename

The same guide warns that enum options are matched against the request and that
nouns can poison queries ("a room named *office* conflicts with the word *off*").
`setActiveMode(mode: live|analysis)` against *"switch to dark **mode**"* is that
case exactly. Renaming it to `setWorkspaceView(view: …)` in the twelve-tool
catalog:

```
"switch to dark mode"      setActiveMode 0.981  ->  setWeatherLayer 0.539 (gated)
"switch to analysis mode"  setActiveMode 0.984  ->  setWorkspaceView 0.990
"make the map dark"        setMapTheme   0.999  ->  setMapTheme      0.999
```

A **safety** win, not an accuracy one: it converts a confident wrong action into
a gated escalation. Note also how sharply phrasing matters — *"make the map
dark"* resolves at 0.999 where *"switch to dark mode"* fails.

### The residual: over-calling, which nothing above fixes

One failure survives every configuration. *"start recording"* — a real request
this catalog cannot serve — returns `setActiveMode` at **1.000** with twelve
tools, at **1.000** with five, and after the rename simply moves to
`toggleDemoFlights` at **1.000**. The model will confidently call *something*
for any plausible-sounding imperative.

This is the failure mode Cactus's fine-tuning guide names directly, and the one
that argues for fine-tuning rather than prompt surgery: include off-topic
examples with **empty** answer arrays, *"roughly 1 in 8"*, to teach abstention.

## Steps 1 and 2 applied and measured (2026-09-22)

`src/lib/needle/prefilter.ts` (pure, 11 tests) scores tools by discriminative
lexical overlap and hands the model at most `MAX_LOCAL_TOOLS = 5`.
`node rust/adsb-needle/scripts/bench-prefilter.mjs` measures it end to end over
22 utterances — the original fourteen plus phrasing variants and four more
must-escalate cases. The benchmark **imports the shipped prefilter** (Node 24
strips types), so it cannot drift from what runs.

| configuration | correct | false-local | missed |
|---|---|---|---|
| 12 tools, original descriptions | 11/22 | 5 | 6 |
| 12 tools, fixed descriptions | 13/22 | 4 | 5 |
| prefiltered ≤5, original descriptions | **17/22** | 4 | 1 |
| prefiltered ≤5, fixed descriptions | 15/22 | **2** | 5 |

Both levers work, and they trade against each other: the prefilter buys
*correctness*, the description fix buys *safety*. **False-locals more than
halve, 5 → 2**, and the two worst — `toggleDemoFlights` for "delete the
scenario" and `setActiveMode` for "start recording", both at 1.000 — are gone.

### Step 2 was a description edit, not a rename

`setActiveMode` described itself as *"Switch between live tracking **mode** and
analysis **mode**"* and captured *"switch to dark **mode**"* at 0.98. Tested
against the engine, four variants:

| `setActiveMode` variant | "switch to dark mode" | "night mode please" |
|---|---|---|
| baseline | `setMapTheme` 0.99 | `setActiveMode` 0.99 ✗ |
| description without "mode" | `setMapTheme` 0.99 | *abstain* 1.00 |
| description naming the rival | `setMapTheme` 0.99 | *abstain* 1.00 |
| renamed `setWorkspaceView` | `setMapTheme` 0.99 | *abstain* 1.00 |

**The description alone is sufficient** — renaming buys nothing, so the tool
keeps its name and the change has no blast radius. Applied in all four places
that carry it (`useCopilotTools.ts`, `tools.py`, the benchmark fixture, the
prefilter test catalog); `setMapTheme` was also given the *"dark mode"* /
*"night mode"* phrasings explicitly, the same disambiguation-by-description
technique the `toggleDemoFlights` episode established.

### Two things the prefilter taught us

**IDF does not remove stopwords.** It discounts terms common *in this catalog*
("map", "aircraft"), but a function word appearing in one description is scored
as highly discriminative — exactly backwards. "at" occurs once, so *"what is the
callsign of the aircraft **at** FL340"* ranked `setWeatherLayer` top at 6.05 and
the model filtered the map at 0.99. Fixed with an explicit function-word list.
`on`/`off` are deliberately **not** on it: they carry polarity, which is the
entire content of "turn on the wind barbs".

**Lexical scoring has a recall hole, and a stopword was hiding it.**
*"go to 48.85, 2.35"* now selects **zero** tools, because it shares no content
word with *"Pan and zoom the map to a specific location"*. It previously matched
on "to" — retrieval by accident. Empty is the safe direction (no tools → the
model abstains → the turn escalates), but it is the ceiling on lexical
prefiltering, and the reason to move this to `needle_embed`, which the WASM
build exports. Pinned by its own test so it is recorded, not hidden.

## Step 3 — triggers, and why the prefilter is not in the path (2026-09-22)

`triggers` is a documented tool-schema field this project had not used: a list
of regex patterns; a match restricts decoding to the tools that matched. It is
the vendor's prescribed mechanism for "phrasings descriptions cannot
enumerate". Five of the twelve tools now carry patterns, declared in
`routable.ts` beside the guard they support and emitted by `buildCatalog`.

Four configurations, same engine, same 22 utterances:

| configuration | correct | false-local | missed |
|---|---|---|---|
| 12 tools | 13/22 | 4 | 5 |
| **12 + triggers** | **17/22** | **2** | 3 |
| prefiltered ≤5 | 15/22 | 2 | 5 |
| prefilter + triggers | 17/22 | 2 | 3 |

**Triggers alone equal prefilter + triggers.** The prefilter earns nothing on
top, and it costs something the earlier measurements had not exposed:

### The catalog is fixed at `needle_init`

A prefilter changes the catalog *per utterance*, so it forces a re-init on every
turn. Measured in WASM:

```
needle_init with 12 tools:  4378 ms  (1057 prefix tokens)
needle_init with  5 tools:  1277 ms  ( 398 prefix tokens)
needle_init with  1 tool:    226 ms  (  81 prefix tokens)
```

1 277 ms *plus* ~400 ms to answer, against **402 ms** with a fixed catalog
initialised once at launch. Triggers live inside that static catalog: paid once,
matched per utterance by the engine, free per turn.

So `prefilter.ts` stays as the benchmark baseline it now documents itself to be
— it is how the five-tool retrieval threshold was found — but it is **not in the
routing path**.

### Triggers steer selection; they do not forge confidence

Probed with a deliberately bad pattern (`\brecord\b` on `setMapTheme`),
*"how many flights did we record last Tuesday?"* was indeed steered onto
`setMapTheme` — at **0.577**, so the 0.85 gate still held. Worth knowing: an
over-broad pattern degrades the answer but does not defeat `decide()`. The
patterns are still written narrowly, excluding rivals' nouns per the vendor
guide, and the bench's eight must-escalate cases are the regression test.

### What triggers did not fix

Two false-locals survive, and they are the fine-tuning case, not a pattern case:

```
1.000  toggleDemoFlights{enabled:false}  <- "delete the scenario called approach test"
1.000  setActiveMode{mode:"live"}        <- "start recording"
```

Both are **over-calling**: a plausible-sounding imperative the local catalog
cannot serve, answered confidently anyway. Argument grounding is the other gap —
*"night mode please"* now reaches `setMapTheme` but fills `{theme:"light"}`.
Cactus's fine-tuning recipe targets exactly these two: `reasoning` lines for
grounding, and ~1 in 8 off-topic examples with empty answer arrays for
abstention.

## Two traps in the official `--serve` build

Both fail **silently**, returning a confident, plausible-looking answer rather
than an error. Both cost real time here:

1. **The body parser does not tolerate a space after the colon.**
   `{"input": "x"}` — what `json.dumps` emits by default — parses as an **empty**
   input, and every turn then returns the same call at the same confidence
   (`toggleSidebar` at 0.989 for fourteen different prompts). Use
   `separators=(",",":")`.
2. `POST /reset` before the first `/complete` produces the same symptom. The C
   API's `needle_reset` is unaffected — the WASM bench calls it between every
   turn and gets varied, sane answers.

## Recommendation

**Not "do not ship" — "do not ship *this configuration*."** An earlier revision
of this document concluded the former, on the twelve-tool measurement that the
vendor's own guide says not to run.

The host question is settled, and favourably: the plan's original choice — WASM
in the Next.js frontend — **works**. 402 ms/turn after a 4.2 s warm-up, no Rust
FFI, no sidecar, no cross-origin isolation, at the full twelve-tool catalog.
Linking `libneedle.a` into `src-tauri` buys another 8x (50 ms) if wanted.

Three things to do, cheapest first, each independently measurable:

1. **Never show the model more than five tools.** Free, and the largest single
   effect measured here (3/5 → 5/5, and the worst false-local gone). The
   prefilter can be lexical — these twelve are well separated ("sidebar",
   "dark", "density", "wind", "analysis") — or `needle_embed`, which the WASM
   build exports. Note this is *not* the same as letting the engine's own
   retrieval pick five: that is what produced the bad numbers, because it
   retrieves against an embedding of the whole catalog with no product knowledge.
2. **Rename `setActiveMode` and audit the twelve for lexically poisoned
   names/enums.** Cheap, and converts confident-wrong into gated-escalation.
3. **Fine-tune on this tool catalogue.** The residual over-calling
   (*"start recording"* → any tool, 1.000) is not reachable by prompt surgery,
   and it is exactly what the vendor's fine-tuning recipe targets.

### On fine-tuning (the vendor's own numbers)

- Data is JSONL: `query`, `tools`, `answers`, plus an optional-but-recommended
  `reasoning` line deriving each argument from its span in the query.
- **A few hundred clean examples measurably improve which tool gets picked.**
  Argument *grounding* needs "on the order of thousands, with varied phrasings".
  Our problem is selection and abstention, so the cheap end applies.
- **~1 in 8 examples must be off-topic with an empty answer array**, to stop
  over-calling. This is the residual above; it is the reason to fine-tune.
- `needle finetune data.jsonl --epochs 10 --out adapter.safetensors`, then
  `needle build --lora adapter.safetensors [--layers N] --out tuned.cact`. LoRA
  on the frozen base, locally, in JAX. Cactus quote 0.71 s/step on an M5 Max.
- Published effect: fine-tuning on DroidCall lifts every subnetwork by **18–36
  points**, and from 4 layers up the tuned subnetwork passes DeepSeek V4 Flash.
  A tuned shallow ladder would also cut the 4.2 s WASM init.
- The same guide cautions that for large catalogues, two passes at inference
  beat more training — consistent with (1) above. Do (1) and (2) first, then
  measure; fine-tune the gap that remains.

A dataset for this is largely **generatable**: the twelve schemas are known, the
guards already encode what a valid call looks like, and the negative eighth can
be drawn from the backend-only tool list (scenario writes, DuckDB reads, feed
control) — real requests that must escalate.

What already stands on its own regardless: the tool registry (single source of
truth, so the local catalog cannot drift from the LLM's), the guards (which
caught one false-local unaided), the decision layer, and the three benchmark
harnesses, which re-run against any future engine, catalog or fine-tune in
seconds. **`decide.ts` needs no change for any of the three steps above.**

---

## Appendix — the community `needle-rs` port

**Historical only.** Before the official `wasm/` and `macos-arm64/` folders were
found, the only runtime known here was the community `needle-rs@0.3.1` (MIT,
wasm-bindgen) and its `needle-infer`/`needle-core` crates. Every figure in this
appendix measures **that port**, not Needle 3 and not WebAssembly. It is kept
because two of its lessons generalise.

| host | per turn (12 tools) | prefill |
|---|---|---|
| community WASM | 38 000 ms | ~59 tok/s |
| community native (`simd` + `parallel`, release) | 10 869 ms | 205 tok/s |

Against the official engines that is **~94x** (WASM) and **~217x** (native)
slower. Only ~3x of the WASM gap is kernel speed; the rest is architectural — the
port re-prefilled all 1 032 catalog tokens **twice per turn**, once to generate
and once to score, because its `confidence_for()` is a separate scoring pass over
the whole prompt. The official engine caches the static prefix at init and
returns confidence inline.

The port is also slow for a specific, diagnosable reason: **`needle-core` gates
every SIMD path in the hot loop on `target_arch = "x86_64"`** — `cq.rs` (the
Cactus-Quants matmul) 5 x86_64 sites / **0 aarch64**, `model.rs` 2 / 0. On Apple
Silicon the matmul runs scalar, and `-C target-cpu=native` changes nothing (a
packed 2-bit matmul is bit manipulation LLVM will not auto-vectorise).

### The two lessons worth carrying

- **Never characterise a model's calibration from a community port.** This
  document previously reported "zero false-locals across 100+ turns, two hosts,
  four depths, every catalog size down to one" as the feature's headline safety
  property. It was an artifact of the port's own documented "approximated"
  confidence being far more conservative than the real head. The official engine
  reversed it on the first run.
- **Benchmark harnesses re-order JSON.** An earlier catalog-size table read 4/14
  at every size because the harness sliced the catalog through
  `serde_json::Value`, a `BTreeMap`, which re-sorted object keys so every tool
  went out as `{"description",…}` where the app sends `{"name",…}`. A different
  prompt, and measurably a different answer. Carry tool objects as `RawValue`.

### Catalog narrowing — no longer relevant, recorded for completeness

On the port, cost was ~linear in prompt tokens and the prompt was 98% catalog, so
narrowing the catalog was the obvious lever: 12 tools 10 869 ms → 4 tools
2 622 ms → 2 tools 1 598 ms → 1 tool 984 ms, with accuracy *improving* (5/14 →
8/14) because twelve lexically adjacent tools (`setLayerVisibility` vs
`setDensityConfig` vs `setWeatherLayer`, all "show a thing on the map") crowd
each other.

**The latency half of that argument is dead** — the official engine does the full
catalog in 50 ms native / 402 ms WASM, because the catalog is prefilled once. The
accuracy half may still hold and is untested against the official engine; the
model card's own advice points the same way (*"declare more than five tools so
Needle can keep only retrieved tools in the per-turn prefix"* — i.e. the engine
already does this via `needle_embed`, which the WASM build exports).

## Reproducing

```bash
npm run needle:prepare      # container into public/needle/ (35.3 MB)

# the three hosts, same catalog and same fourteen utterances
cd ../adsb-needle
sh   scripts/bench-official.sh                                 # official native
node scripts/bench-wasm.mjs                                    # official WASM
cargo test -p adsb-needle --release -- --ignored --nocapture   # community port
```

Both benchmark scripts download an engine from Hugging Face into `$TMPDIR`. It is
the same repo as the weights, but it is **code** — read them before running.
Neither is in `npm test` or `cargo test`'s default set.

The native steady-state (`--serve`) figure is not produced by a committed script;
it is `bench-official.sh`'s cases replayed against `needle --serve`, with compact
JSON bodies per the trap above. The early WASM spike scripts were deliberate
throwaways and are not committed.
