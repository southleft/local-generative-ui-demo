# Stamp 3: the exam result, and what to do with it

Run: `mix-all` (688 examples), 3 epochs, 2,064 iterations on an M1 Max in about 2.5 hours of GPU time across three segments (two macOS GPU resets, resumed from checkpoints by `train-supervised.sh`). Validation loss 1.31 → 0.46. Adapters in `training/runs/mix-all/final`, fused model in `training/runs/mix-all/fused`, outputs in `training/runs/eval-mix-all.jsonl`, scorer report in `training/runs/eval-report.md`.

| model | valid JSON | strict pass | rendered | first try, no node loss | median adjustments | median nodes | median s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| stock Gemma 4 E2B | 11 / 58 | 10 / 58 | 58 | 54 | 2 | 15 | 8.1 |
| fine-tuned, mix-all | 48 / 58 | 48 / 58 | 58 | 41 | 2 | 17 | 13.3 |

Reading: the model learned the syntax (strict-valid output ×5) and learned to write bigger pages, which loop under greedy decoding (17 runs lost a component, mostly repeated cards and duplicate ids in settings pages, plus a few missing required props). Usable-without-loss went down 54 → 41. Full breakdown in `HOW-THE-FINE-TUNE-WORKS.md` §5.

## Options

1. **Publish as is.** The honest finding is strong for the blog: a fine-tune moves the failure class rather than removing it, and the eval layer is what tells you so. Costs nothing more.
2. **One more run, cheapest first.** Two epochs on the same mix (loss plateaued at ~1,300 iterations; the extra epoch may be what taught the looping), about 1.5 h. Or `mix-gemma` (320 examples, the model's own shorter voice), about 1 h. Or re-assemble with teacher examples capped at 20 components, then retrain.
3. **Change the exam to match the app.** Add the app's verbatim-repetition cut-off to `eval_generate.py` so both models are scored the way the app would render them. Cheap, and fair to both.

Recommendation: 3 first (it's a fairness fix, minutes), then 2 with two epochs if there's time, then 1 with whatever the numbers say.

## Result (11 September, evening)

Option 3 came for free: the browser exam runs through the app's own generation path, cut-off included, so it is the fair exam. Option 2 (two epochs) ran as `mix-all-2ep` (1,376 iterations, 72 min, no GPU reset, val loss 0.502) and was scored in the browser against the shipped three-epoch export and stock Gemma over all 58 held-out prompts: valid JSON 50 vs 46 vs 4, strict 50 vs 43 vs 1, first-try no node loss 38 vs 35 vs 38, prompts needing repetition removal 5 vs 15 vs 13. The two-epoch artifact ships (`training/runs/release/`). Duplicate ids remain in 19 prompts for every model and are the next data fix. Full log: `docs/decision-log.md`.
