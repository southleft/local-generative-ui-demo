#!/usr/bin/env bash
# Supervised LoRA training: resumes from the latest adapter checkpoint after a GPU
# reset (macOS kills long Metal command buffers that "impact interactivity") until
# TOTAL iterations are done, then fuses. Progress survives crashes in
# training/runs/<mix>/progress.txt and latest.safetensors.
#   training/scripts/train-supervised.sh mix-all 2064
set -uo pipefail
cd "$(dirname "$0")/../.."
MIX="${1:?mix}"; TOTAL="${2:?total iterations}"
RUN="training/runs/$MIX"; DATA="training/data/$MIX"; PY="training/.venv/bin/python"
export HF_TOKEN="${HF_TOKEN:-$(for f in "${ENV_FILE:-}" .env ../../../.env; do [ -n "$f" ] && [ -f "$f" ] && grep -E '^HF_TOKEN=' "$f" | cut -d= -f2- | tr -d '"\'' ' && break; done)}"
export TOKENIZERS_PARALLELISM=false
STATE="$RUN/progress.txt"; CKPT="$RUN/latest.safetensors"
mkdir -p "$RUN/segments"
attempt=0; segment=""
while :; do
  completed=$(cat "$STATE" 2>/dev/null || echo 0)
  remaining=$(( TOTAL - completed ))
  [ "$remaining" -le 0 ] && break
  segment="$RUN/segments/$(printf %04d "$completed")"
  mkdir -p "$segment"
  resume=(); [ -f "$CKPT" ] && resume=(--resume-adapter-file "$CKPT")
  echo "=== segment from iteration $completed: $remaining remaining (attempt $attempt) ==="
  "$PY" training/scripts/lora_nothink.py -c training/configs/lora-gemma4-e2b.yaml --data "$DATA" --adapter-path "$segment" "${resume[@]}" --iters "$remaining"
  status=$?
  last=$(ls "$segment"/0*_adapters.safetensors 2>/dev/null | sort | tail -1)
  if [ -n "$last" ]; then
    n=$(basename "$last" | cut -d_ -f1 | sed 's/^0*//'); cp "$last" "$CKPT"; echo $(( completed + n )) > "$STATE"
  fi
  if [ "$status" -eq 0 ]; then
    [ -f "$segment/adapters.safetensors" ] && cp "$segment/adapters.safetensors" "$CKPT"
    echo "$TOTAL" > "$STATE"; break
  fi
  attempt=$(( attempt + 1 ))
  [ "$attempt" -ge 8 ] && { echo "giving up after $attempt attempts"; exit 1; }
  echo "=== crashed (exit $status); resuming in 30 s ==="
  sleep 30
done
mkdir -p "$RUN/final"
cp "$CKPT" "$RUN/final/adapters.safetensors"
cp "$segment/adapter_config.json" "$RUN/final/adapter_config.json"
"$PY" -m mlx_lm fuse --model training/models/gemma-4-E2B-it-text --adapter-path "$RUN/final" --save-path "$RUN/fused"
echo "done: adapters in $RUN/final, fused model in $RUN/fused"
