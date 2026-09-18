#!/usr/bin/env bash
# Publish a trained run to the Hugging Face Hub: the runnable .litertlm, its pruned tokenizer and
# vocabulary map, the LoRA adapters, and a model card.
# Usage: publish-hf.sh <run dir, e.g. training/runs/mix-all-ids> <repo, e.g. bvoran/gemma-4-e2b-a2ui-catalog> <model card .md>
set -euo pipefail
cd "$(dirname "$0")/../.."
RUN="${1:?run dir}"; REPO="${2:?repo id}"; CARD="${3:?model card markdown}"
HF="$HOME/.local/share/uv/tools/litert-torch-nightly/bin/hf"
export HF_TOKEN="${HF_TOKEN:-$(for f in "${ENV_FILE:-}" .env ../../../.env; do [ -n "$f" ] && [ -f "$f" ] && grep -E '^HF_TOKEN=' "$f" | cut -d= -f2- | tr -d '"\'' ' && break; done)}"
ART="$RUN/litertlm-v32k-int8/model-sp.litertlm"
[ -f "$ART" ] || { echo "no artifact at $ART" >&2; exit 1; }
STAGE="$(mktemp -d)"
cp "$ART" "$STAGE/gemma-4-e2b-it-a2ui-catalog-v32k-int8.litertlm"
cp "$RUN/fused-hf-v32k/tokenizer.spm" "$STAGE/tokenizer.spm"
cp "$RUN/fused-hf-v32k/vocab-map.json" "$STAGE/vocab-map.json"
mkdir -p "$STAGE/lora"; cp "$RUN/final/adapters.safetensors" "$RUN/final/adapter_config.json" "$STAGE/lora/"
cp "$CARD" "$STAGE/README.md"
shasum -a 256 "$STAGE"/*.litertlm | tee "$STAGE/SHA256SUMS"
"$HF" repos create "$REPO" --type model --exist-ok >/dev/null 2>&1 || "$HF" repos create "$REPO" --type model || true
"$HF" upload "$REPO" "$STAGE" . --repo-type model --commit-message "Publish $(basename "$RUN"): catalog-tuned Gemma 4 E2B, 32k vocabulary, int8 .litertlm"
echo "published: https://huggingface.co/$REPO"
echo "artifact URL: https://huggingface.co/$REPO/resolve/main/gemma-4-e2b-it-a2ui-catalog-v32k-int8.litertlm"
rm -rf "$STAGE"
