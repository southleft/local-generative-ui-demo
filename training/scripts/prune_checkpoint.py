#!/usr/bin/env python3
"""Make a text-only local copy of google/gemma-4-E2B-it that mlx-lm loads strictly.

The Hugging Face checkpoint carries k_proj / v_proj / k_norm for the 20 KV-shared top layers
(unused: those layers reuse earlier keys and values) plus the vision and audio towers. mlx-lm's
Gemma 4 model defines neither, and its strict loader refuses unknown tensors. Drop them here once.

    training/.venv/bin/python training/scripts/prune_checkpoint.py
"""
import glob
import json
import shutil
from pathlib import Path

import mlx.core as mx

SNAPSHOT = Path(glob.glob(str(Path.home() / ".cache/huggingface/hub/models--google--gemma-4-E2B-it/snapshots/*"))[0])
OUT = Path(__file__).resolve().parents[1] / "models" / "gemma-4-E2B-it-text"
OUT.mkdir(parents=True, exist_ok=True)

config = json.loads((SNAPSHOT / "config.json").read_text())
text = config.get("text_config", config)
first_shared = text["num_hidden_layers"] - text["num_kv_shared_layers"]
print(f"layers {text['num_hidden_layers']}, kv-shared from layer {first_shared}")

DROP_PREFIXES = ("model.vision_tower", "model.audio_tower", "model.embed_audio", "model.embed_vision", "model.multi_modal_projector", "model.vision_embedder", "vision_tower", "audio_tower", "embed_audio", "embed_vision", "multi_modal_projector", "vision_embedder")


def unused_kv(name: str) -> bool:
    parts = name.split(".")
    if "layers" not in parts:
        return False
    layer = int(parts[parts.index("layers") + 1])
    return layer >= first_shared and parts[-2] in {"k_proj", "v_proj", "k_norm"}


kept, dropped, dropped_bytes = {}, [], 0
for file in sorted(SNAPSHOT.glob("*.safetensors")):
    weights = mx.load(str(file))
    for name, tensor in weights.items():
        if name.startswith(DROP_PREFIXES) or unused_kv(name):
            dropped.append(name)
            dropped_bytes += tensor.nbytes
            continue
        kept[name] = tensor
print(f"kept {len(kept)} tensors, dropped {len(dropped)} ({dropped_bytes / 1e9:.2f} GB): {sum(1 for d in dropped if unused_kv(d))} unused kv, {sum(1 for d in dropped if d.startswith(DROP_PREFIXES))} vision/audio")
mx.save_safetensors(str(OUT / "model.safetensors"), kept, metadata={"format": "pt"})
for name in ["config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json", "tokenizer.model", "special_tokens_map.json", "chat_template.jinja", "chat_template.json", "added_tokens.json"]:
    src = SNAPSHOT / name
    if src.exists():
        shutil.copy(src, OUT / name)
(OUT / "PRUNED.md").write_text("Text-only copy of google/gemma-4-E2B-it: vision/audio towers and the unused k/v projections of the KV-shared layers removed so mlx-lm loads it strictly. Weights otherwise byte-identical.\n")
print(f"wrote {OUT} ({sum(f.stat().st_size for f in OUT.iterdir()) / 1e9:.2f} GB)")
