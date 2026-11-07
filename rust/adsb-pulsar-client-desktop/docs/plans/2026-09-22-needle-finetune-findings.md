# Fine-tuning Needle 3 on this app's tool catalogue

## Why

With `triggers` in place the on-device router reaches **17/22** on
`scripts/bench-prefilter.mjs`. Two failures remain, and neither is reachable by
a regex or a description:

| failure | example | measured |
|---|---|---|
| **over-calling** | "start recording" → `setActiveMode{mode:"live"}` | confidence **1.000** |
| | "delete the scenario called approach test" → `toggleDemoFlights` | confidence **1.000** |
| **argument grounding** | "night mode please" → `setMapTheme{theme:"light"}` | right tool, wrong value |

Cactus's fine-tuning guide targets both: `reasoning` lines that derive each
argument from its span in the query, and ~1 example in 8 that is off-topic with
an **empty** answer list.

## The dataset

```sh
python build_dataset.py --out .        # train / validation / test .jsonl
uv run --with pytest python -m pytest -q
```

339 examples: 268 train, 34 validation, 37 test; **46 abstentions (13.6%)**.
Every one of the twelve tools has positive examples, and none is more than 18%
of all calls. Generated, seeded, and **not committed** — it is ~1.3 MB because
the format repeats the catalogue on every row, and it is reproducible from this
script.

Three properties the tests enforce, each protecting something specific:

- **No benchmark utterance appears in any split.** `bench-prefilter.mjs` is the
  only measurement of this work; training on its cases would improve every
  future score and the failure would be invisible. Paraphrases are intended.
- **Splits are keyed on a hash of the query**, not shuffled, so adding
  templates later does not move existing rows between train and test and
  quietly invalidate a before/after comparison.
- **No call is one a guard would reject.** The guards in `routable.ts` are
  narrower than the JSON schema — `setEventFilter` offers `mode:"range"` in its
  schema and the guard refuses it, so training on it would teach a call that
  always escalates.

## Baseline — the stock model on the held-out split

`node ../scripts/eval-finetune.mjs` scores `test.jsonl` (37 rows the builder
kept out of training), with the same gate as `decide.ts`:

| metric | stock `needle3.cact` |
|---|---|
| tool chosen correctly | 16/32 |
| **arguments exact** | **7/32** |
| abstained when required | 3/5 |
| **false-local** | **3** |

Grounding is the weak half, exactly as the bench suggested: the tool is right
twice as often as the arguments are. The signature failure repeats verbatim —

```
1.000 setMapTheme {"theme":"light"}  want {"theme":"dark"}  <- "switch the map to night"
1.000 setMapTheme {"theme":"light"}  want {"theme":"dark"}  <- "night theme please"
0.959 setMapTheme {"theme":"dark"}   want {"theme":"light"} <- "day mode"
0.986 setWeatherLayer {"enabled":true,"level":"wind barbs"} want {"barbs":true}
```

The last one invents a `level` value; `resolveWeatherLevel` rejects it, so the
guard escalates rather than acting — a reminder that the guards are load-bearing
and not just belt-and-braces.

## Training

```sh
pip install cactus-needle
needle finetune train.jsonl --epochs 10 --out adapter.safetensors
needle build --lora adapter.safetensors --out tuned.cact
needle build --lora adapter.safetensors --layers 8 --out tuned_8l.cact
```

LoRA on the frozen base, locally in JAX; Cactus quote ~0.71 s/step on Apple
Silicon. At batch 16, 268 examples is ~17 steps per epoch, so 10–30 epochs is
minutes. Read the loss by its **trend**, not its level — it starts near 1.0
because only the reasoning line and the call are scored, and most of the
boilerplate is already in the base model. Stop when validation loss rises while
training loss keeps falling.

`needle build` quantises to 4-bit locally (2-bit needs the Cactus Platform), so
a tuned container is **larger** than the stock 35.3 MB one. A shallower
`--layers` slice would cut both that and the 4.2 s WASM `needle_init`.

## Result: fine-tuning made it worse (2026-09-22)

Trained 12 epochs, loss 0.656 -> 0.388, adapter 7.9 MB. Then a **quantisation
control**, because `needle build` exports a merged model at **W4A8 (63 MB)**
where the published base is **CQ 2-bit (35 MB)** -- two variables changed at
once. The control is a **zero-valued LoRA**: merging it is mathematically the
identity, but it forces the identical dequantise -> merge -> W4A8 export.

(`needle build` with *no* `--lora` is not a control: with nothing to merge it
short-circuits and copies the published CQ2 archive byte-for-byte.)

Held-out split, 32 actionable rows + 5 that must abstain:

| model | tools | args | abstain | false-local |
|---|---|---|---|---|
| stock CQ2 (published) | 16/32 | 7/32 | 3/5 | 3 |
| **control W4A8** (identity merge) | **17/32** | 6/32 | 4/5 | **1** |
| tuned W4A8 | 13/32 | 5/32 | 4/5 | **4** |

**The export is exonerated; the training is the cause.** The control shares the
tuned model's export path, size, tensor count and dropped confidence head, and
differs only in having zero LoRA weights -- so the gap between 17/32 with 1
false-local and 13/32 with 4 is the fine-tune itself.

Why, most likely: 268 templated examples x 12 epochs on a 121M model is
memorisation, and the damage shows up exactly on held-out rows from the same
generator. Cactus warn that wrong argument values mean a dataset too small **or
uniform**; ours was both. The `night` cluster makes it concrete -- 3 examples in
train, 5 in test, because the hash split scatters a *semantic* cluster unevenly.

**Do not scale this generator.** More of the same templates would deepen the
overfit. What is needed before any retry:

1. **Stratify the split by intent cluster**, not by query hash.
2. **Real phrasing variety** -- `needle finetune --generate N` (OpenRouter) or
   hand-written, not more template permutations.
3. **Fewer epochs and a smaller LoRA rank** (16, alpha 32 / scale 2.0 was
   aggressive for 268 examples).

### A free win, independent of fine-tuning

The W4A8 re-export of the **stock** model beats the published CQ2 base on this
task: 17/32 vs 16/32 tools and **1 false-local vs 3**, untrained. 4-bit is less
lossy than 2-bit. The cost is bundle size, 63 MB vs 35 MB.

Two caveats before banking it: differences of 1-3 over 32 items are small (the
runs are deterministic -- greedy decode -- so this is not run-to-run noise, but
the sample is thin); and the W4A8 export **drops the confidence head** yet still
reports confidences, so the score being gated on is an uncharacterised fallback.
It gated better here, which is worth understanding before relying on it.

### The confidence gate does not work, and never did

`node ../scripts/calibration.mjs <model>` asks the only question that matters
for a gated design: does the reported confidence separate right calls from
wrong ones? Over the held-out split, "right" meaning the right tool **and**
exact arguments:

| model | mean conf right | mean conf wrong | AUC | zero-wrong threshold |
|---|---|---|---|---|
| stock CQ2 (head present) | 0.859 | 0.826 | **0.614** | unreachable |
| control W4A8 (head dropped) | 0.764 | 0.803 | 0.615 | unreachable |
| **tuned W4A8** (head dropped) | 0.959 | 0.757 | **0.810** | unreachable |

Three conclusions, in order of importance:

1. **No threshold admits zero wrong calls, on any model.** Some wrong call
   always scores at or above every right one — all three emit wrong calls at
   1.000. So confidence *alone* cannot be the gate, and the original design
   premise ("execute immediately when confident") is unsound as stated. What
   actually provides safety is the **guards** and the **triggers**; confidence
   is at best a third filter.
2. **The published confidence head was never a gate for our tools.** AUC 0.614
   is barely above a coin flip. Earlier worry that `needle build` drops the head
   was misplaced — it removed something that was not working here anyway
   (0.615 without it).
3. **Fine-tuning substantially improved calibration**: AUC 0.614 -> 0.810, mean
   confidence 0.959 when right against 0.757 when wrong. The tuned model is
   *worse at choosing* and markedly *better at knowing when it is right*. That
   is the one clear win from training, and accuracy-only scoring hid it.

The shipped 0.85 threshold admits 13-14 wrong calls in every configuration. It
is not doing the job it was introduced to do.

**Revised success criterion.** "Zero false-locals at >= 18/22" is not reachable
by tuning confidence. The target for any retry is a model whose confidence has
a **reachable zero-wrong threshold** on the held-out split — i.e. every wrong
call scores below some right call. Until that exists, the feature stays dark.

### GPU acceleration is not available

`jax-metal` is dead (last release 2024-10-08, needs jaxlib >= 0.4.26; we run
0.11.2; upstream closed all its issues in Dec 2025). `jax-mps` 0.11.0 installs,
registers `MpsDevice(id=0)` and runs a matmul 1.11x faster than the CPU -- then
crashes on Needle's attention mask:

```
jax_plugins/mps/ops.py:1543  _patched_dot_product_attention
    fused_mask = jnp.broadcast_to(m, (B, N, T, S))
ValueError: input bool[1,2048,1,2048] -> requested bool[16,12,2048,2048]
```

The plugin assumes a `[B,1,T,S]` mask; Needle lays its out `[B,T,1,S]`. So
training stays on CPU at **1.34 min/step** (measured: 204 steps in 273 min),
which puts 5 000 examples x 12 epochs at ~84 hours.

## Second attempt, with every data problem fixed: still no gain

Stratified split, 432 rows, abstentions sub-clustered, rank 8 / alpha 16 /
6 epochs (down from 16 / 32 / 12). Held-out split, 50 actionable + 6 abstain:

| model | tools | args | abstain | false-local |
|---|---|---|---|---|
| **control W4A8** (untrained) | **20/50** | 11/50 | **4/6** | 5 |
| tuned2 W4A8 | 19/50 | 11/50 | 3/6 | 5 |

| model | conf right | conf wrong | AUC | zero-wrong |
|---|---|---|---|---|
| control | 0.942 | 0.760 | 0.754 | unreachable |
| tuned2 | 0.969 | 0.731 | 0.766 | unreachable |

**No improvement over doing nothing**, and the criterion is missed by a wide
margin: `toggleDemoFlights` fires at **1.000** for "stop the feed" on both.

Run 1 overfit (loss 0.656 -> 0.388, memorising templates); run 2 underfit (loss
*ended higher* than it started, 0.705 -> 0.794). Both failed to beat the
control. That does **not** prove fine-tuning cannot work here -- rank and epochs
were changed together, so the middle configuration (rank 16, ~6 epochs) is
untested -- but two reasonable attempts, with the data problems fixed, both lost
to doing nothing, and each costs ~3 h of CPU.

Note on comparing AUCs: the control scored 0.615 on the first split and 0.754
on the stratified one. The **split** changed, so those are not comparable; only
control-vs-tuned within a single run is.

## Third attempt, on the corrected dataset

The abstention examples in runs 1 and 2 trained without a `<think>` block, so
the anti-over-calling mechanism was never actually exercised (see the audit
above). Run 3 fixes that, adds the two never-taught arguments, and uses the
previously untested middle hyperparameters: rank 16, alpha 32, 6 epochs.

Held-out split, 52 actionable + 6 must-abstain:

| model | tools | args | abstain | false-local |
|---|---|---|---|---|
| **control W4A8** (untrained) | **21/52** | **11/52** | **4/6** | **5** |
| tuned3 | 18/52 | 9/52 | 3/6 | 6 |

| model | conf right | conf wrong | AUC | zero-wrong |
|---|---|---|---|---|
| control | 0.947 | 0.767 | 0.750 | unreachable |
| **tuned3** | 0.975 | 0.709 | **0.808** | unreachable |

22-case bench, `12 + triggers`: **18/22 with 1 false-local** -- the best that
configuration has scored, but it does not carry to the larger held-out set.

**The fix was necessary and insufficient.** With 47 correctly-shaped abstention
examples across seven kinds, the model still reasons its way into a call:
"stop the feed" -> `toggleDemoFlights` at 1.000, and abstention fell to 3/6
against the control's 4/6. The base model's prior -- always emit a call -- is
not moved by a rank-16 LoRA over 5 weight groups on 327 examples.

**Calibration is the one consistent gain**: AUC 0.810 (run 1), 0.766 (run 2,
which underfit), 0.808 (run 3), against 0.750 for the control. Fine-tuning
reliably teaches the model *when it is right* and not *what is right*.

Loss also behaved differently once abstentions carried reasoning -- it started
at 1.270 rather than ~0.70, because 14% of rows suddenly had a target the model
did not already produce. That is the signature of the fix taking effect.

## Verdict

**Stop fine-tuning locally.** Three runs, the last on an audited and corrected
dataset with the previously untested hyperparameters, all lose to the untrained
control on tool choice and none reaches a zero-wrong confidence threshold.

The shipped configuration stays the untrained model plus `triggers`. What blocks
this feature is not tool choice -- triggers largely fixed that -- but that **no
confidence threshold separates right calls from wrong ones**, on any model we
can produce. That is a property of the base model's prior, which a LoRA over
5 weight groups does not move.

If it is ever resumed, in order of expected value:

1. `needle platform finetune` -- trains the **full model** on Cactus GPUs, not
   a LoRA over 5 weight groups, and preserves both 2-bit quantisation and the
   confidence head. It is the only route that can plausibly shift the
   always-call prior. Uploads the catalogue and training data.
2. Real, non-generated phrasings; every row here came from templates.
3. Far more abstention examples. 47 across seven kinds did not dent it; the
   vendor's "1 in 8" may be calibrated to catalogues less adjacent to the
   model's training distribution than twelve near-identical view controls.

**What fine-tuning demonstrably does buy**, if it is ever wanted for its own
sake: calibration. AUC 0.750 untrained -> 0.808-0.810 tuned, reproducibly.

## The success criterion, fixed in advance

**Zero false-locals across the 22-case benchmark plus the held-out test split,
at ≥ 18/22 correct.** Below that, the feature stays dark: `decide.ts` already
escalates safely, and a router that is confidently wrong is worse than no
router.

Re-derive the 0.85 confidence threshold after training. Confidence already does
not port between the native and WASM builds of the *same* engine, so it
certainly will not survive a fine-tune.
