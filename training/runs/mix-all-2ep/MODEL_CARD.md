---
license: gemma
base_model: google/gemma-4-E2B-it
tags:
  - litert-lm
  - litertlm
  - gemma
  - a2ui
  - generative-ui
  - lora
  - webgpu
language:
  - en
pipeline_tag: text-generation
---

# Gemma 4 E2B, tuned to speak A2UI for one component catalog

A LoRA fine-tune of `google/gemma-4-E2B-it` that writes [A2UI v0.9](https://a2ui.org) compositions for an 18-component design-system catalog, exported as a **standard `.litertlm` that runs in the browser** through [LiteRT-LM.js](https://www.npmjs.com/package/@litert-lm/core) on WebGPU. It is the third model in the [browser-local generative UI prototype](https://github.com/southleft/local-generative-ui-demo) next to stock Gemma 4 E2B and Chrome's built-in Gemini Nano.

## What is in this repo

| file | what it is |
| --- | --- |
| `gemma-4-e2b-it-a2ui-catalog-v32k-int8.litertlm` | 2.14 GB. int8 decoder and tables, vocabulary pruned to 32,768 tokens, SentencePiece tokenizer inside, Google's Gemma 4 chat template. Loads in LiteRT-LM.js 0.14 on `backend: GPU` (non-streaming path) and in the LiteRT-LM Python SDK / CLI. |
| `tokenizer.spm` | The pruned SentencePiece model (same bytes as the section inside the `.litertlm`). |
| `vocab-map.json` | Kept original token ids in order; new id = index. All ids below 1024 are unchanged, so `<bos>`, `<eos>` and `<turn|>` keep their ids. |
| `lora/adapters.safetensors`, `lora/adapter_config.json` | The mlx-lm LoRA adapter (rank 16, scale 20, q/k/v/o projections, last 16 layers). Apply to the full-vocabulary base if you want the unpruned model. |

## How it was trained

- Base `google/gemma-4-E2B-it`; LoRA rank 16, scale 20, dropout 0.05, attention projections of the last 16 layers (2.1 M trainable parameters), lr 1e-5, batch 1, sequence length 4,096, **two epochs** (1,376 iterations, 72 minutes on an M1 Max with mlx-lm 0.31). Thinking channel disabled so training matches inference.
- Data: 688 request → composition pairs from three labelled sources, each validated by the prototype's guardrail so every target is a composition the app would render: the stock model's own outputs after repair (240), a stronger teacher's outputs that passed strict validation (388), and compositions derived from the component schema (96). Prompts are the prototype's exact production prompt (catalog table plus the A2UI transport rules).
- The vocabulary was pruned after training: every control, byte-fallback and user-defined piece, every id below 1024, every token the corpus uses (11,323 of 262,144) and the highest-scored remaining pieces up to 32,768. The two embedding tables and the tied output head were about 60% of the int8 model; the prune is what fits the file into the browser runtime's 4 GB WASM heap.

## What it scores

58 held-out requests, greedy decoding, scored by the prototype's guardrail. "First try, no node loss" means the page rendered without any component being dropped or de-duplicated.

| in the browser (LiteRT-LM.js 0.14, WebGPU, fresh Chrome, same prompt and guardrail) | valid JSON | strict pass | rendered | first try, no node loss | median salvage adjustments | median s |
| --- | --- | --- | --- | --- | --- | --- |
| stock Gemma 4 E2B (Google's standard 2.59 GB file) | 4 / 58 | 1 | 57 | 38 | 6 | 12.4 |
| **this model** | **50 / 58** | **50** | **58** | 38 | 2 | 20.6 |

Known weaknesses: repeated ids on long pages (about a third of the held-out pages need one id renamed or one duplicate removed by the guardrail), and about 20 seconds per page on an M1 Max. Post-training int4 quantisation destroys the fine-tune in every form we tried (per-channel, weight-only, blockwise); use int8.

## How to run it

In the browser, the package's default path streams only Google's `-web` artifacts. Use the non-streaming path with the file placed inside the WASM heap; the reference loader is [`src/litert-heap-loader.ts`](https://github.com/southleft/local-generative-ui-demo/blob/main/src/litert-heap-loader.ts) in the prototype (about 150 lines, unit-tested). With the LiteRT-LM Python SDK:

```python
import litert_lm
engine = litert_lm.Engine("gemma-4-e2b-it-a2ui-catalog-v32k-int8.litertlm", backend=litert_lm.Backend.CPU(), max_num_tokens=4096)
conv = engine.create_conversation(system_message="Follow the output format exactly. Never emit executable code.")
print(conv.send_message(prompt))
```

The model expects the prototype's prompt (the catalog table and the A2UI transport rules) and answers with `{"root": ..., "components": [...]}`. Because the vocabulary is pruned, text outside English, JSON and the catalog's terms tokenises into byte pieces the model was not trained on.

## License and provenance

Derived from Gemma 4 and provided under the [Gemma Terms of Use](https://ai.google.dev/gemma/terms); use is subject to the Gemma Prohibited Use Policy. Training data was generated for this prototype; the decision log with every alternative tried is in the prototype's `docs/decision-log.md`.
