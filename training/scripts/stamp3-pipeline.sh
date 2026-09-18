#!/usr/bin/env bash
# Stamp 3 pipeline, strictly one heavy job at a time:
#   1. 58-prompt browser exam of the shipped catalog-tuned model (fresh Chrome)
#   2. same exam for Google's stock file
#   3. two-epoch retrain of mix-all (1,376 iterations, resumable across GPU resets)
#   4. merge → prune vocabulary → export int8 → repack tokenizer
#   5. 58-prompt browser exam of the retrained model
# Progress lines go to training/runs/stamp3/pipeline.log; each stage skips itself when its output exists.
set -uo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
OUT="training/runs/stamp3"; mkdir -p "$OUT"
LOG="$OUT/pipeline.log"
SCRATCH_PY="$ROOT/training/.venv/bin/python"
TORCH_PY="$HOME/.local/share/uv/tools/litert-torch-nightly/bin/python"
SDK_PY="${LITERT_SDK_PYTHON:-training/.venv-litertlm/bin/python}"  # a venv with `pip install litert-lm` (Google's SDK; used to unpack/repack the .litertlm)
DEV="http://localhost:5174"
say() { echo "$(date '+%H:%M:%S') $*" | tee -a "$LOG"; }
exam() { # name url
  local name="$1" url="$2"
  if [ -s "$OUT/exam-$name.jsonl" ]; then say "exam $name: already done"; return 0; fi
  say "exam $name: start ($url)"
  node training/scripts/browser-suite.mjs "$url" eval "$OUT/exam-$name.json" > "$OUT/exam-$name.console.log" 2>&1
  local rc=$?
  say "exam $name: exit $rc, rows $(wc -l < "$OUT/exam-$name.jsonl" 2>/dev/null || echo 0)"
  return $rc
}

say "=== pipeline start ==="
exam tuned-3ep "$DEV/models/gemma-4-e2b-catalog-int8.litertlm" || say "exam tuned-3ep FAILED (continuing)"
exam stock "$DEV/@fs/${ROOT#/}/training/models/probe/gemma-4-E2B-it.litertlm" || say "exam stock FAILED (continuing)"

# --- retrain: two epochs of mix-all under its own run name ---
MIX="mix-all-2ep"
[ -e "training/data/$MIX" ] || ln -s mix-all "training/data/$MIX"
if [ -f "training/runs/$MIX/final/adapters.safetensors" ]; then
  say "retrain: adapters already exist"
else
  say "retrain: start (1376 iterations)"
  bash training/scripts/train-supervised.sh "$MIX" 1376 > "$OUT/train-$MIX.console.log" 2>&1
  say "retrain: exit $? (progress $(cat training/runs/$MIX/progress.txt 2>/dev/null))"
fi
[ -f "training/runs/$MIX/final/adapters.safetensors" ] || { say "retrain produced no adapters; stopping"; exit 1; }

# --- merge, prune, export, repack ---
R="training/runs/$MIX"
if [ ! -f "$R/fused-hf/model.safetensors.index.json" ]; then
  say "merge: fuse_hf.py"
  "$TORCH_PY" training/scripts/fuse_hf.py --base "${GEMMA_HF_SNAPSHOT:-$(ls -d ~/.cache/huggingface/hub/models--google--gemma-4-E2B-it/snapshots/* 2>/dev/null | head -1)}" --adapters "$R/final/adapters.safetensors" --config "$R/final/adapter_config.json" --out "$R/fused-hf" > "$OUT/fuse-$MIX.log" 2>&1 || { say "merge FAILED"; exit 1; }
fi
if [ ! -f "$R/fused-hf-v32k/model.safetensors.index.json" ]; then
  say "prune: prune_vocab.py"
  "$TORCH_PY" training/scripts/prune_vocab.py --base "$R/fused-hf" --out "$R/fused-hf-v32k" > "$OUT/prune-$MIX.log" 2>&1 || { say "prune FAILED"; exit 1; }
fi
if [ ! -f "$R/litertlm-v32k-int8/model.litertlm" ]; then
  say "export: litert-torch int8"
  PATH="$HOME/.local/bin:$PATH" nice -n 10 litert-torch export_hf --model="$R/fused-hf-v32k" --output_dir="$R/litertlm-v32k-int8" --quantization_recipe=dynamic_wi8_afp32 --externalize_embedder=True --jinja_chat_template_override=training/models/probe/gemma4-official-chat_template.jinja > "$OUT/export-$MIX.log" 2>&1 || { say "export FAILED"; exit 1; }
  say "export: $(grep -c '| MISSING' "$OUT/export-$MIX.log") missing-weight rows"
fi
if [ ! -f "$R/litertlm-v32k-int8/model-sp.litertlm" ]; then
  say "repack: SentencePiece tokenizer"
  "$SDK_PY" - "$R" <<'PY' >> "$OUT/repack-$MIX.log" 2>&1 || { say "repack FAILED"; exit 1; }
import sys, re, shutil, litert_lm_builder as b
r = sys.argv[1]; d = f"{r}/litertlm-v32k-int8"
b.unpack(f"{d}/model.litertlm", f"{d}/unpacked")
shutil.copy(f"{r}/fused-hf-v32k/tokenizer.spm", f"{d}/unpacked/tokenizer.spm")
toml = open(f"{d}/unpacked/model.toml").read()
new = re.sub(r'section_type = "HF_Tokenizer"\ndata_path = "[^"]+"', 'section_type = "SP_Tokenizer"\ndata_path = "tokenizer.spm"', toml)
assert new != toml
open(f"{d}/unpacked/model-sp.toml", "w").write(new)
print(b.pack(f"{d}/unpacked/model-sp.toml", f"{d}/model-sp.litertlm"))
shutil.rmtree(f"{d}/unpacked", ignore_errors=True)
PY
fi
say "artifact: $(stat -f %z "$R/litertlm-v32k-int8/model-sp.litertlm") bytes"
exam tuned-2ep "$DEV/@fs/${ROOT#/}/$R/litertlm-v32k-int8/model-sp.litertlm" || say "exam tuned-2ep FAILED"
say "=== pipeline done ==="
