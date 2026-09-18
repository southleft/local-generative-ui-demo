#!/usr/bin/env bash
# LoRA fine-tune of Gemma 4 E2B on one assembled mix, locally on Apple Silicon.
#   training/scripts/train.sh mix-all [epochs=3]
# Iterations = epochs × training examples (batch size 1). Adapters land in training/runs/<mix>/adapters,
# the fused model in training/runs/<mix>/fused, and the log in training/runs/<mix>/train.log.
set -euo pipefail
cd "$(dirname "$0")/../.."
MIX="${1:?mix name, e.g. mix-all}"
EPOCHS="${2:-3}"
DATA="training/data/$MIX"
RUN="training/runs/$MIX"
PY="training/.venv/bin/python"
[ -f "$DATA/train.jsonl" ] || { echo "no $DATA/train.jsonl; run assemble.test.ts first" >&2; exit 1; }
export HF_TOKEN="${HF_TOKEN:-$(for f in "${ENV_FILE:-}" .env ../../../.env; do [ -n "$f" ] && [ -f "$f" ] && grep -E '^HF_TOKEN=' "$f" | cut -d= -f2- | tr -d '"\'' ' && break; done)}"
export TOKENIZERS_PARALLELISM=false
N=$(wc -l < "$DATA/train.jsonl" | tr -d ' ')
ITERS=$(( N * EPOCHS ))
mkdir -p "$RUN"
echo "mix=$MIX examples=$N epochs=$EPOCHS iters=$ITERS" | tee "$RUN/train.log"
# Resume after a crash: training/scripts/train.sh <mix> <epochs> <checkpoint.safetensors> <iterations-remaining>
RESUME="${3:-}"
if [ -n "$RESUME" ]; then
  ITERS="${4:?iterations remaining}"
  echo "resuming from $RESUME for $ITERS iterations" | tee -a "$RUN/train.log"
  "$PY" training/scripts/lora_nothink.py -c training/configs/lora-gemma4-e2b.yaml --data "$DATA" --adapter-path "$RUN/adapters" --resume-adapter-file "$RESUME" --iters "$ITERS" 2>&1 | tee -a "$RUN/train.log"
else
  "$PY" training/scripts/lora_nothink.py -c training/configs/lora-gemma4-e2b.yaml --data "$DATA" --adapter-path "$RUN/adapters" --iters "$ITERS" 2>&1 | tee -a "$RUN/train.log"
fi
"$PY" -m mlx_lm fuse --model training/models/gemma-4-E2B-it-text --adapter-path "$RUN/adapters" --save-path "$RUN/fused" 2>&1 | tee -a "$RUN/train.log"
echo "done: adapters in $RUN/adapters, fused model in $RUN/fused" | tee -a "$RUN/train.log"
