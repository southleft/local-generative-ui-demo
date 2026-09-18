"""Fuse the mlx-lm LoRA adapters into the ORIGINAL Hugging Face checkpoint.

Why: `mlx_lm.fuse` writes tensors under mlx-lm's names (language_model.model.*)
and only the pruned text-only tensors, so litert-torch's HF exporter reports
every language-model weight as MISSING and exports randomly initialised
weights. This script applies the same delta mlx-lm applies
(W' = W + scale * lora_b.T @ lora_a.T) to the untouched HF checkpoint, which
keeps HF names and every tensor litert-torch expects.

Usage:
  python fuse_hf.py --base <hf snapshot dir> --adapters <adapters.safetensors> \
      --config <adapter_config.json> --out <output dir>
"""

from __future__ import annotations

import argparse
import json
import os
import shutil

import torch
from safetensors import safe_open
from safetensors.torch import save_file

MLX_PREFIX = "language_model.model."
HF_PREFIX = "model.language_model."
COPY_FILES = (
    "config.json",
    "generation_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "chat_template.jinja",
    "processor_config.json",
    "special_tokens_map.json",
    "tokenizer.model",
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--adapters", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--shard-bytes", type=int, default=5 * 1024**3)
    args = parser.parse_args()

    with open(args.config, encoding="utf-8") as handle:
        scale = float(json.load(handle)["lora_parameters"]["scale"])

    deltas: dict[str, torch.Tensor] = {}
    with safe_open(args.adapters, "pt") as adapters:
        keys = list(adapters.keys())
        bases = sorted({k.rsplit(".", 1)[0] for k in keys})
        for base_key in bases:
            lora_a = adapters.get_tensor(f"{base_key}.lora_a").float()  # (in, r)
            lora_b = adapters.get_tensor(f"{base_key}.lora_b").float()  # (r, out)
            if not base_key.startswith(MLX_PREFIX):
                raise SystemExit(f"unexpected adapter key {base_key}")
            hf_key = HF_PREFIX + base_key[len(MLX_PREFIX):] + ".weight"
            deltas[hf_key] = (scale * lora_b.T @ lora_a.T)  # (out, in)
    print(f"{len(deltas)} tensors to patch, scale={scale}")

    os.makedirs(args.out, exist_ok=True)
    shard_files = sorted(f for f in os.listdir(args.base) if f.endswith(".safetensors"))
    tensors: dict[str, torch.Tensor] = {}
    patched = 0
    for shard in shard_files:
        with safe_open(os.path.join(args.base, shard), "pt") as handle:
            for key in handle.keys():
                tensor = handle.get_tensor(key)
                if key in deltas:
                    delta = deltas.pop(key)
                    if delta.shape != tensor.shape:
                        raise SystemExit(f"shape mismatch for {key}: {delta.shape} vs {tuple(tensor.shape)}")
                    tensor = (tensor.float() + delta).to(tensor.dtype)
                    patched += 1
                tensors[key] = tensor
    if deltas:
        raise SystemExit(f"adapter keys not found in base checkpoint: {sorted(deltas)[:5]} ...")
    print(f"patched {patched} tensors; total tensors {len(tensors)}")

    # Shard by size, write index.
    weight_map: dict[str, str] = {}
    shard_index = 0
    current: dict[str, torch.Tensor] = {}
    current_bytes = 0
    total_bytes = 0

    def flush() -> None:
        nonlocal shard_index, current, current_bytes
        if not current:
            return
        shard_index += 1
        name = f"model-{shard_index:05d}.safetensors"
        save_file(current, os.path.join(args.out, name), metadata={"format": "pt"})
        for key in current:
            weight_map[key] = name
        print(f"wrote {name} ({current_bytes / 1024**3:.2f} GB, {len(current)} tensors)")
        current = {}
        current_bytes = 0

    for key in sorted(tensors):
        size = tensors[key].numel() * tensors[key].element_size()
        if current and current_bytes + size > args.shard_bytes:
            flush()
        current[key] = tensors[key]
        current_bytes += size
        total_bytes += size
    flush()

    # Rename shards to the conventional -of- form.
    total = shard_index
    for i in range(1, total + 1):
        old = f"model-{i:05d}.safetensors"
        new = f"model-{i:05d}-of-{total:05d}.safetensors"
        os.rename(os.path.join(args.out, old), os.path.join(args.out, new))
        for key, value in weight_map.items():
            if value == old:
                weight_map[key] = new
    with open(os.path.join(args.out, "model.safetensors.index.json"), "w", encoding="utf-8") as handle:
        json.dump({"metadata": {"total_size": total_bytes}, "weight_map": weight_map}, handle, indent=2)

    for name in COPY_FILES:
        source = os.path.join(args.base, name)
        if os.path.exists(source):
            shutil.copy2(source, os.path.join(args.out, name))
    print(f"done: {args.out}")


if __name__ == "__main__":
    main()
