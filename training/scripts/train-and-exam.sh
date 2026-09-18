#!/usr/bin/env bash
# Train a mix for N iterations, then merge → prune vocabulary → int8 export → tokenizer repack →
# 58-prompt browser exam. Strictly one heavy job at a time; every stage skips itself when its
# output exists. Usage: train-and-exam.sh <mix> <iterations>   (log: training/runs/<mix>/pipeline.log)
set -uo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
MIX="${1:?mix}"; ITERS="${2:?iterations}"
R="training/runs/$MIX"; mkdir -p "$R"
LOG="$R/pipeline.log"
TORCH_PY="$HOME/.local/share/uv/tools/litert-torch-nightly/bin/python"
SDK_PY="${LITERT_SDK_PYTHON:-training/.venv-litertlm/bin/python}"  # a venv with `pip install litert-lm` (Google's SDK; used to unpack/repack the .litertlm)
DEV="http://localhost:5174"
say() { echo "$(date '+%H:%M:%S') $*" | tee -a "$LOG"; }
say "=== $MIX: $ITERS iterations ==="
[ -f "training/data/$MIX/train.jsonl" ] || { say "no training/data/$MIX/train.jsonl"; exit 1; }
if [ -f "$R/final/adapters.safetensors" ]; then say "train: adapters already exist"; else
  say "train: start"; bash training/scripts/train-supervised.sh "$MIX" "$ITERS" > "$R/train.console.log" 2>&1
  say "train: exit $? (progress $(cat "$R/progress.txt" 2>/dev/null))"
fi
[ -f "$R/final/adapters.safetensors" ] || { say "no adapters; stopping"; exit 1; }
grep -o "Iter [0-9]*: Val loss [0-9.]*" "$R/train.console.log" | tail -1 | xargs -I{} echo "$(date '+%H:%M:%S') train: last {}" | tee -a "$LOG"
if [ ! -f "$R/fused-hf/model.safetensors.index.json" ]; then say "merge: fuse_hf.py"
  "$TORCH_PY" training/scripts/fuse_hf.py --base "${GEMMA_HF_SNAPSHOT:-$(ls -d ~/.cache/huggingface/hub/models--google--gemma-4-E2B-it/snapshots/* 2>/dev/null | head -1)}" --adapters "$R/final/adapters.safetensors" --config "$R/final/adapter_config.json" --out "$R/fused-hf" > "$R/fuse.log" 2>&1 || { say "merge FAILED"; exit 1; }; fi
if [ ! -f "$R/fused-hf-v32k/model.safetensors.index.json" ]; then say "prune: prune_vocab.py"
  "$TORCH_PY" training/scripts/prune_vocab.py --base "$R/fused-hf" --out "$R/fused-hf-v32k" > "$R/prune.log" 2>&1 || { say "prune FAILED"; exit 1; }; fi
if [ ! -f "$R/litertlm-v32k-int8/model.litertlm" ]; then say "export: litert-torch int8"
  PATH="$HOME/.local/bin:$PATH" nice -n 10 litert-torch export_hf --model="$R/fused-hf-v32k" --output_dir="$R/litertlm-v32k-int8" --quantization_recipe=dynamic_wi8_afp32 --externalize_embedder=True --jinja_chat_template_override=training/models/probe/gemma4-official-chat_template.jinja > "$R/export.log" 2>&1 || { say "export FAILED"; exit 1; }
  say "export: $(grep -c '| MISSING' "$R/export.log") missing-weight rows"; fi
if [ ! -f "$R/litertlm-v32k-int8/model-sp.litertlm" ]; then say "repack: SentencePiece tokenizer"
  "$SDK_PY" - "$R" <<'PY' >> "$R/repack.log" 2>&1 || { say "repack FAILED"; exit 1; }
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
if [ -s "$R/exam.jsonl" ]; then say "exam: already done"; else say "exam: start"
  node training/scripts/browser-suite.mjs "$DEV/@fs/${ROOT#/}/$R/litertlm-v32k-int8/model-sp.litertlm" eval "$R/exam.json" > "$R/exam.console.log" 2>&1
  say "exam: exit $?, rows $(wc -l < "$R/exam.jsonl" 2>/dev/null || echo 0)"; fi
say "=== $MIX done ==="
