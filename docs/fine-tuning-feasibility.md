# Can I fine-tune my own model to speak A2UI and this catalog — and run it here?

Research memo, 24 August 2026. Question: is it practical for one developer to fine-tune an open-weight small model so it emits this prototype's A2UI v0.9 component syntax against the 18-component catalog more reliably than stock Gemma 4 E2B, and then run that model in the browser through `@litert-lm/core` (LiteRT-LM.js) on WebGPU?

**Short answer: the fine-tune is the easy half; the browser is the blocker.** Training a LoRA on Gemma 4 E2B for this format is a weekend of work on a free Colab. Getting the result into LiteRT-LM.js is not currently possible with public tooling, because the web runtime only loads Google-produced `-web.litertlm` artifacts and exposes no adapter loading. Chrome's built-in Prompt API cannot take a custom model at all.

## 1. What LiteRT-LM.js will load today — confidence: high

The official docs and the in-repo README for `@litert-lm/core` say the JS API "currently supports a limited set of web-compatible models" and list only `gemma-4-E2B-it-web.litertlm` and `gemma-4-E4B-it-web.litertlm` (text in, text out, WebGPU). Release 0.15.0 (31 Jul 2026) added Gemma 4 12B / 26B-A4B / 31B — again as `-web` artifacts. The package the prototype pins, 0.14.0 (1 Jul 2026), is two releases behind; 0.16.0 shipped 11 Aug 2026.

One caveat to how this prototype words it: `local-model.ts` says Qwen3-0.6B is "not supported by LiteRT-LM.js 0.14" because the runtime rejected its prefill/decode format. That was an empirical failure on one file and version, not a documented policy — there is no allowlist in the JS source, the official chat demo has an `importCustomModel()` path, the litert-community Qwen3-0.6B card publishes a "LiteRT-LM WebGPU" benchmark, and a third-party wrapper reports it loading on core 0.12.1. Worth re-testing on 0.16 rather than asserting.

Sources: https://developers.google.com/edge/litert-lm/js · https://github.com/google-ai-edge/LiteRT-LM/blob/main/js/packages/core/README.md · https://github.com/google-ai-edge/LiteRT-LM/releases · https://huggingface.co/litert-community/Qwen3-0.6B

## 2. Converting a fine-tuned checkpoint to `.litertlm` — confidence: high for CLI/Android, medium that web is *not* user-producible

The public path exists and is documented by Google for exactly this use: merge the LoRA into the base with PEFT, then

```
uv tool install litert-torch-nightly
litert-torch export_hf --model=<hf-repo> --output_dir=... --externalize_embedder
```

produces `model.litertlm`. Google's own tutorial does this for a fine-tuned Gemma 3 270M and runs it on the CLI and Android. `export_hf` supports Gemma 3 / 3n / 4 and Qwen 2.5 / 3, with a default `dynamic_wi8_afp32` quantization and a `--quantization_recipe` override. It does not mention web.

What "-web" means: Google staff on Hugging Face describe the web variant as having "different prefill signature lengths, optimizations to the KV cache layout, all tailored to run more efficiently on WebGPU," produced by a separate hand-crafted process; the Gemma 4 E2B card calls it "a specially optimized model for Web because of its unique memory constraints" with a 2/4/8-bit mixed scheme. The `export_hf` config exposes `prefill_lengths`, GPU dynamic prefill, NPU AOT backends, and quant recipes — but no web target. A Google reply in the Gemma 4 conversion thread pointed at the MediaPipe converter, which then failed for a user with "Unknown special model: GEMMA_4_E2B" (unresolved).

Nothing states users *cannot* build a web-loadable file; the evidence is the absence of tooling plus the docs' "we're working on expanding this to cover general `.litertlm` model files" language.

Sources: https://developers.google.com/edge/litert-lm/tutorials/convert-and-run · https://developers.google.com/edge/litert/conversion/pytorch/genai · https://huggingface.co/google/gemma-3n-E2B-it-litert-lm/discussions/6 · https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/discussions/7 · https://github.com/google-ai-edge/litert-torch/issues/984

## 3. Loading a LoRA adapter at runtime instead — confidence: medium (native), high (not on web)

The native runtime has a `LoraManager`, `EngineSettings::SetScopedLoraFile`, and a May 2026 commit adding dynamic LoRA injection to the LLM executor — none of it publicly documented. Issue #1188 (public LoRA API request, Jan 2026) is unanswered; issue #3173 (7 Aug 2026) reports a `LoraConfig(lora_path=...)` adapter against the published Gemma 4 E2B `.litertlm` having zero effect, hypothesizing the base was exported without injection points; also unanswered. In `litert-torch`, LoRA is attention-only and wired into the legacy converter, not `export_hf`.

On the web, the WASM binding exposes only `GpuArtisanConfig.supported_lora_ranks` ("empty, meaning not supporting any lora ranks") and no adapter-load call. The older MediaPipe LLM Inference web API did have `loraRanks` / `loadLoraModel`, GPU-only, restricted to Gemma-2 2B, Gemma 2B and Phi-2, and that API is in maintenance mode.

Sources: https://github.com/google-ai-edge/LiteRT-LM/issues/3173 · https://github.com/google-ai-edge/LiteRT-LM/issues/1188 · https://developers.google.com/edge/mediapipe/solutions/genai/llm_inference/web_js

## 4. The fine-tune itself — confidence: high

- Unsloth runs Gemma 4 E2B LoRA on 8–10 GB VRAM (E4B ≈ 17 GB) with free T4 Colab notebooks; their example uses r=8, α=8 and exports merged 16-bit safetensors or GGUF. Their dataset guide: "bare minimum of at least 100 rows," 1,000+ preferable; under ~300 rows, tune the *instruct* model.
- Google's TRL/QLoRA guide fine-tunes Gemma 1B for text-to-SQL with r=16, α=16, 3 epochs, 10k samples on a T4.
- A published structured-output result: Gemma 4 E4B and Qwen3-4B with 8-bit QLoRA (r=32) on ~1,700 tool-use examples lifted argument-F1 from 0.47 to 0.65.
- No A2UI-specific fine-tune exists in public. A2UI v0.9 is explicitly "prompt-first" — designed to be taught in the prompt rather than relying on structured-output modes.

Practical read for this catalog: a few hundred high-quality examples should fix *format* adherence (flat array, id references, `value: { path }` only on inputs, no inlined children); 1k+ if the goal is also layout judgment.

**The dataset already exists in this repo.** `sessions/generation-log.ndjson` records, per run, the exact prompt and the *validated* composition — i.e. the salvage layer's output. That output is precisely the target a fine-tune should learn: the model's own content, serialized correctly. The guardrails are, in effect, a labeler. Filter to runs with zero content-loss warnings, compile each composition back to the flat A2UI component array the prompt asks for, and pair it with the request; that is SFT data with no synthetic generation step.

Sources: https://unsloth.ai/docs/models/gemma-4/train · https://unsloth.ai/docs/get-started/fine-tuning-llms-guide/datasets-guide · https://ai.google.dev/gemma/docs/core/huggingface_text_finetune_qlora · https://arxiv.org/abs/2605.17774 · https://developers.googleblog.com/a2ui-v0-9-generative-ui/

## 5. Chrome's built-in Prompt API — confidence: high

Gemini Nano only. The API's docs mention JSON Schema `responseConstraint` and nothing about developer-supplied models or adapters; the one LoRA that exists (Summarizer) was trained by Google and shipped as a Chrome-controlled download; the W3C explainer scopes the API to "browser-provided language models."

Sources: https://developer.chrome.com/docs/ai/prompt-api · https://developer.chrome.com/blog/improved-summaries-gemini-nano · https://github.com/webmachinelearning/prompt-api

## Where that leaves the secondary goal

1. **Fine-tune: yes, cheaply.** Gemma 4 E2B-it + LoRA (r=8–16) on the session-log corpus, a few hundred examples, a T4. Evaluate with this repo's own parser: the honest metric is *zero salvage adjustments needed*, not schema validity.
2. **Run it in LiteRT-LM.js: not today.** Export produces a CLI/Android `.litertlm`; the web runtime wants a `-web` artifact only Google produces, and offers no adapter loading. Watch the LiteRT-LM releases for "general `.litertlm`" web support (the docs promise it) and re-test on 0.16+.
3. **Run it in the browser some other way: yes.** The thesis of the prototype is "a local model speaks A2UI"; it is not tied to LiteRT. A merged fine-tune can run in-browser today via WebLLM/MLC (compile to their WebGPU format) or Transformers.js/ONNX Runtime Web for a smaller model. That is a different loader behind the same `AppModelApi` interface in `App.tsx` — the A2UI catalog, salvage layer, and renderer are untouched.
4. **Run it natively: yes.** The exported `.litertlm` runs on the LiteRT-LM CLI and Android now, which is enough to *measure* whether the fine-tune reduces salvage adjustments before deciding the browser path is worth chasing.

Flags: the LoRA and web-variant findings rest partly on source code and unanswered GitHub issues rather than documentation; the Qwen3-0.6B claim comes from an HF benchmark table and a third-party wrapper, not the official supported list.
