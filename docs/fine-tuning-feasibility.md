# Can I fine-tune my own model to speak A2UI and this catalog — and run it here?

Research memo, 24 August 2026. Question: is it practical for one developer to fine-tune an open-weight small model so it emits this prototype's A2UI v0.9 component syntax against the 18-component catalog more reliably than stock Gemma 4 E2B, and then run that model in the browser through `@litert-lm/core` (LiteRT-LM.js) on WebGPU?

**Short answer: yes, and it now runs in the browser: a LoRA fine-tune, vocabulary-pruned to 32k tokens and exported at int8 (2.14 GB), loads through the unmodified LiteRT-LM.js on WebGPU and beats stock Gemma on the held-out prompts (§2, 11 September).** Training a LoRA on Gemma 4 E2B for this format is a weekend of work on a free Colab. The web runtime's *default* path only streams Google-produced `-web.litertlm` artifacts and exposes no adapter loading, but its non-streaming `backend: GPU` path takes standard `.litertlm` exports once the file is placed inside the WASM heap (verified with Google's own non-web Gemma 4 E2B file). Chrome's built-in Prompt API cannot take a custom model at all.

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

**Verified 11 September 2026.** A LoRA fine-tune of Gemma 4 E2B was fused, exported with `litert-torch export_hf` (5.07 GB, `dynamic_wi8_afp32`, sections: LlmMetadata, ExecutorMetadata, HF_Tokenizer_Zlib, prefill_decode, embedder, per_layer_embedder) and loaded through the app's own `loadLiteRtModel` in Chrome. LiteRT-LM.js 0.14 rejected it at `Engine.create` with `Streaming HF_Tokenizer_Zlib section is not supported yet`. Repacked with the SentencePiece tokenizer section lifted from Google's `gemma-4-E2B-it-web.litertlm` (its layout is three sections: LlmMetadata, SP_Tokenizer, one TFLiteModel of type `tf_lite_artisan_text_decoder` with `backend_constraint: gpu_artisan`), the runtime rejected it one step later with `Streaming kTfLitePrefillDecode models is not supported yet`. The 0.17.0 runtime still lists streamed embedder models as unsupported, so the same layout fails there too. The web runtime streams only "artisan" text decoders, the WebGPU-compiled form Google produces for its own artifacts, and `litert-torch` has no artisan or web target. So: the browser path through LiteRT-LM.js is closed for custom models until Google ships the tooling, and the practical in-browser route for a fine-tune is Transformers.js with an ONNX export (the community publishes `onnx-community/gemma-4-E2B-it-ONNX` for WebGPU at 4-bit, about 3.1 GB text-only).

**Reopened 11 September 2026 (evening): the web runtime has a second load path, and it takes standard files.** Reading `@litert-lm/core` 0.14's `engine.js` shows that `Engine.create` only streams when the backend is `GPU_ARTISAN` (the default). For `backend: GPU` or `backend: CPU` it copies the whole file into the WASM virtual filesystem and calls the ordinary `Engine.createEngine`, and the WASM binary contains the ordinary executor (`LlmLiteRtCompiledModelExecutor`), the statically linked "GPU WebGPU" accelerator (ML Drift) and XNNPACK for CPU. The "Streaming … not supported yet" errors above belong only to the artisan streaming loader. Verified live in Chrome, same unmodified 0.14 WASM:

- The package's own non-streaming path fails for any multi-GB file with `RangeError: Array buffer allocation failed`: it holds the download as chunks, a concatenated copy and a MEMFS copy, and this Chrome build refuses a single ArrayBuffer of 2 GB (1.5 GB allocates, 2 GB does not).
- Workaround, no rebuild needed: `wasm._malloc` the file inside the 4 GB WASM heap, stream the download straight into `HEAPU8`, create an empty MEMFS node and give it `stream_ops` whose `mmap` returns `{ ptr: base + position, allocated: false }`. The runtime's `MAP_PRIVATE` section maps then alias the heap block instead of copying (MEMFS would otherwise `mmapAlloc` + copy every section). Reference implementation: `src/vfs-backend-probe.ts` (`runProbe3`).
- With that loader, Google's standard non-web `gemma-4-E2B-it.litertlm` (2.59 GB: SP tokenizer, `tf_lite_embedder`, `tf_lite_per_layer_embedder`, `tf_lite_prefill_decode`, audio/vision sections, MTP drafter) loaded on `backend: GPU` in 6 s, WASM heap 3.0 GB, and answered "Reply with exactly five words about the sea." with "Vast, blue, endless, mysterious, powerful." (deterministic across three loads). Through the app's real prompt and guardrail (`generateModelText` → `parseComposition` → official processor), six held-out prompts rendered 9–41 nodes in 12.6–52 s, never valid JSON, always salvaged, i.e. stock-Gemma behaviour.
- The session API also works without the chat template (`createSession` → `runPrefill([...]) ` → `runDecode`), decoding at about 30 tokens/s.

Two export traps found on the way: (1) `mlx_lm.fuse` writes `language_model.model.*` tensor names and only the pruned text tensors, so `litert-torch export_hf` lists every language-model weight as MISSING and silently exports random weights (garbage output). `training/scripts/fuse_hf.py` applies the LoRA delta (`W + scale · lora_bᵀ · lora_aᵀ`, mlx-lm's own formula) to the original HF checkpoint instead; the log then shows 0 MISSING rows. (2) The HF checkpoint's July 2026 "canonical" Gemma 4 chat template uses `.get()` 23 times, which the runtime's minja rejects (`Failed to apply template: unknown method: map has no method named get`); export with `--jinja_chat_template_override=<Google's litertlm chat_template.jinja>`. The int8 export is 5.07 GB and cannot fit the 4 GB heap; `--quantization_recipe=dynamic_wi4_afp32` gives 2.38 GB.

**Quantization, 11 September evening.** With the fuse and template fixed, three exports of the same fine-tune were run through Google's native runtime (`litert-lm` 0.17 Python SDK, CPU) over six held-out prompts and scored by the repo's own eval replay (`training/runs/eval-report-native-6.md`):

| export | file | native: valid JSON | strict | rendered | first try, no loss | median adj | median nodes | in the browser |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| stock Gemma 4 E2B (Google's file) | 2.59 GB | 2 / 6 | 1 | 6 | 3 | 5 | 18 | loads, 6 s, heap 3.0 GB |
| fine-tune, `dynamic_wi8_afp32` (int8) | 4.72 GB | 6 / 6 | 6 | 6 | 5 | 1 | 19 | does not fit the 4 GB heap |
| fine-tune, `dynamic_wi4_afp32` (channelwise int4) | 2.38 GB | 0 / 6 | 0 | 0 | 0 | – | – | loads (heap 3.6 GB), same garbage |
| fine-tune, `weight_only_wi4_afp32` | 2.38 GB | native call fails | – | – | – | – | – | aborts at the 4 GB ceiling during delegate setup |

The int8 export reproduces the MLX bf16 fine-tune byte-for-byte on the dashboard prompt, so the pipeline is correct; channelwise post-training int4 destroys the learned format (channel tokens, empty output, stock-style markdown JSON), and the weight-only int4 graph carries a dequantize step that materialises float weights and overruns the WASM heap. Google's own web file is int4-class because it was quantization-aware trained with a mixed 2/4/8-bit scheme, which no public tool reproduces. Blockwise int4 (`training/configs/quant-int4-block32.json`, a JSON recipe for the quantizer: FULLY_CONNECTED in 32-weight blocks, everything else channelwise int4; 2.50 GB) was then tried alone. In the browser it loads within budget (heap 3.76 GB) but through kernels far too slow to use: 61 s to load instead of 6, and the runtime's GPU readback timeout fired after three words of the five-word answer. Natively it keeps the trained format for the first few components, then corrupts (`"component","Tag"`) and loops to 10,498 characters that nothing can render. So every post-training int4 form tested either does not fit, does not run at speed, or does not preserve the fine-tune; int8 preserves it and does not fit. Two cheaper instruments then replaced further exports. (1) Repacking the same int4 file with Google's SentencePiece tokenizer instead of the 32 MB Hugging Face one (`litert_lm_builder` unpack, edit `model.toml`, pack) cut the WASM heap from 3.40 to 3.10 GB for a 2.38 GB file, so the runtime's working memory is about 0.7 GB and the file budget is about 3.3 GB. (2) `training/scripts/eval_fakequant.py` applies the exporter's exact quantization arithmetic (symmetric min/max, per output row or per 32-block, int4 range [-8, 7], int8 [-127, 127]) to chosen tensors of the fused MLX model and runs the six held-out prompts in about two minutes per configuration. Scored by the same eval replay:

| fake-quant configuration | valid JSON | rendered | first try, no loss | would-be file |
| --- | --- | --- | --- | --- |
| decoder FC int4 per channel, tables untouched | 0 / 6 | 0 | 0 | – |
| decoder FC int4, the 32 tuned tensors int8 | 0 / 6 | 0 | 0 | 2.5 GB |
| decoder FC int8, both tables int4 | 6 / 6 | 6 | 4 | 3.45 GB |
| (native int8 export, for reference) | 6 / 6 | 6 | 5 | 4.72 GB |

So int4 on the untuned decoder layers breaks Gemma 4 E2B itself, not just the adapter; the decoder must stay int8. Further fake-quant runs closed the remaining precision doors: 2-bit on either table is garbage, int4 on the MLP alone breaks, blockwise int4 on the MLP with int8 attention nearly holds (4 / 6 valid) but rides on blockwise kernels of unverified browser speed.

**The route that worked: prune the vocabulary, keep int8.** Gemma's 262,144-token vocabulary is most of the model here: the two embedding tables and the tied output head are about 60% of the int8 file, and the prototype's prompts plus the whole training set use 11,323 tokens. `training/scripts/prune_vocab.py` keeps every control, byte-fallback and user-defined piece, every id below 1024 (so `<bos>`, `<eos>` and `<turn|>` keep their ids), every token the corpus uses, and the highest-scored remaining pieces up to 32,768; it slices `embed_tokens` and `embed_tokens_per_layer` in the same order and writes a matching SentencePiece model. On MLX the pruned model scores 5 / 6 valid, 6 rendered, 5 first-try clean (`training/scripts/eval_pruned.py`), the same as the unpruned int8 run. Exported at plain `dynamic_wi8_afp32` and repacked with the pruned tokenizer, the file is **2.14 GB** (decoder 1.81, embedder 0.05, per-layer table 0.27).

Verified in the browser on 11 September 2026, in a fresh extension-free Chrome driven by `training/scripts/browser-suite.mjs` (same heap-resident loader, `backend: GPU`, the app's real prompt, `generateModelText`, `parseComposition`, official processor), six held-out prompts, raw results in `training/runs/browser-suite-*.json`:

| in the browser, same page and guardrail | load | heap | valid JSON | strict | first try, no loss | adjustments per prompt | nodes | seconds per prompt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| stock Gemma 4 E2B (Google's 2.59 GB file) | 5.0 s | 3.28 GB | 0 / 6 | 0 | – | 4, 6, 5, 2, 8, 17 | 9–41 | 8.6–49.2 |
| fine-tune, 32k vocabulary, int8 (2.14 GB) | 8.1 s | 3.06 GB | 5 / 6 | 5 | 6 rendered | 3, 5, 0, 0, 0, 4 | 14–34 | 16.5–34.4 |

Caveats for the write-up: the browser-side slowness seen earlier in the day (49–61 s loads, "timeout was reached while reading back data") was Ben's long-running Chrome, not the files: the same files load in 5–8 s in a fresh instance. Unseen user text that needs a pruned token falls back to byte pieces the model never saw in training, so a free-text prompt outside English and JSON will tokenise differently than the full model would; the six held-out prompts were fully covered. The lone non-strict prompt (sourdough) was still rendered with 22 nodes after five adjustments.

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
2. **Run it in LiteRT-LM.js: yes, since 11 September.** Not through the streaming path (that still wants Google's `-web` artifacts) but through the runtime's non-streaming `backend: GPU` path with the file placed inside the WASM heap (`src/litert-heap-loader.ts`). The constraints are the 4 GB heap and int4 sensitivity, solved by pruning the vocabulary to 32k tokens and exporting at int8 (2.14 GB). It ships in the prototype as the fourth LiteRT model, `gemma-4-e2b-catalog`, served in dev by `vite.config.ts` and by `VITE_TUNED_MODEL_URL` in a deployed build.
3. **Run it in the browser some other way: held in reserve.** Transformers.js/ONNX Runtime Web has no 4 GB heap ceiling, so it is the route if a model larger than E2B is ever wanted; WebLLM lacks Gemma 4. Either would be one more `ModelProvider` in `src/model-provider.ts`; the A2UI catalog, salvage layer and renderer are untouched.
4. **Run it natively: yes.** The exported `.litertlm` runs on the LiteRT-LM CLI and Android now, which is enough to *measure* whether the fine-tune reduces salvage adjustments before deciding the browser path is worth chasing.

Flags: the LoRA and web-variant findings rest partly on source code and unanswered GitHub issues rather than documentation; the Qwen3-0.6B claim comes from an HF benchmark table and a third-party wrapper, not the official supported list.
