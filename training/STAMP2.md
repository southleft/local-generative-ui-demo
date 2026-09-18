# Stamp 2: dataset review before training

Generated 2026-09-10/11. Everything below is reproducible from `training/scripts/`.

## Sources (final)

| Source | Generated | Kept | Rejected (why) | Nodes per example |
| --- | --- | --- | --- | --- |
| Gemma through the guardrail | 397 runs | 240 | 145 lost nodes in salvage, 10 under 4 nodes, 2 failed | 4–41, median 16 |
| Teacher (claude-sonnet-5, strict parse, zero salvage) | 397 | 388 | 4 not valid JSON, 1 failed the A2UI shape, 4 too long for the window | 11–44, median 20 |
| Catalog (schema-derived, correct by construction) | 96 | 96 | none | 3–11, median 3 |

The Gemma run itself, on the 397 training prompts: 395 rendered, 392 on the first attempt, 53 valid JSON without repair (13%), 250 rendered without losing a node (63%), median 21 s. Clean rate by family: form 27/44, chat 29/44, dashboard 33/44, settings 18/44, compare 24/44, checkout 25/44, free-form 94/133. Settings is the weakest shape for the browser model, which matches the Nano findings.

Teacher cost: about 815k input and 790k output tokens including the 55 regenerations after the first pass truncated long compositions at 2,500 tokens.

## Mixes written (`training/data/mix-*/`, mlx-lm chat format)

| Mix | Train | Valid | Composition |
| --- | --- | --- | --- |
| mix-gemma | 320 | 16 | Gemma 240 + catalog 96 |
| mix-teacher | 460 | 24 | teacher 388 + catalog 96 |
| mix-all | 688 | 36 | Gemma 240 + teacher 388 + catalog 96 |

Every example: system turn "Follow the output format exactly. Never emit executable code.", user turn = the exact LiteRT production prompt (catalog table, rules, blueprint, transport schema as text), assistant turn = canonical `{ "root": "root", "components": [...] }` in A2UI component syntax. Rendered without Gemma 4's thinking channel, matching how the eval and the app prompt the model. Loss is on the assistant turn only.

## The baseline the fine-tunes must beat

Stock Gemma 4 E2B on MLX (bf16, greedy, no thinking), 58 held-out prompts including the six sparks, Gerald, and the rocket. Scored through the real guardrail.

| | valid JSON | strict pass | rendered | first try, no node loss | median adjustments | median nodes | median seconds |
| --- | --- | --- | --- | --- | --- | --- | --- |
| stock Gemma 4 E2B | 11 / 58 | 10 / 58 | 58 / 58 | 54 / 58 | 2 | 15 | 8.1 |

That matches the browser: valid JSON about one time in five, the guardrail carrying the rest. By family, valid JSON: form 1/7, chat 1/7, dashboard 3/7, settings 0/7, compare 1/6, checkout 0/7, free-form 5/17.

## Two things the data run surfaced

- **A real bug in the app.** Generation slowed from a 13 s median to 34 s after about 75 runs in one page, then to minutes. The app never released LiteRT conversations, so every generation left its KV cache alive in the WASM runtime. `generateModelText` now deletes each conversation when it finishes (both repos, tested). Worth a line in the blog: the session log found it.
- **MLX and the browser must not share the GPU.** Loading the 9 GB model for the MLX smoke test while Chrome was generating on WebGPU stalled the browser run and wedged the bridge. Training and evaluation run only when the browser is idle.

## Decisions for you

1. **Mix.** `mix-all` is my recommendation: the teacher supplies volume and layout quality, the 240 Gemma examples keep the model's own voice in the set, the catalog set nails prop vocabulary. `mix-gemma` (320) is now large enough to train as the pure guardrail-as-labeler control, which would make the blog's cleanest claim. Training both is two runs of a few hours each.
2. **Epochs.** Three (about 2,000 iterations for `mix-all`, batch 1). I'll cut to two if a run passes six hours.

Say the mix (or "both") and "train".
