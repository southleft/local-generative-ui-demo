"""Prune Gemma 4 E2B's 262,144-token vocabulary to the pieces this prototype can use.

Why: the two embedding tables and the tied output head are ~60% of the int8 model, and the
prompts + training targets use 11k tokens. A 32k vocabulary keeps int8 quality and brings the
export under the browser runtime's 4 GB heap.

Keeps: every non-normal piece (control, byte-fallback, user-defined), every id below --keep-low,
every token id that appears in the corpus, then the highest-scored normal pieces up to --size.
New id = position in the ascending list of kept old ids, so all low ids (bos, eos, <turn|>) are unchanged.

Writes: <out>/ (sliced HF checkpoint + config with the new vocab size, full tokenizer files copied),
<out>/tokenizer.spm (pruned SentencePiece model for the runtime), <out>/vocab-map.json (old<->new ids).
Usage: <litert-torch python> training/scripts/prune_vocab.py --base training/runs/mix-all/fused-hf --out training/runs/mix-all/fused-hf-v32k
"""
from __future__ import annotations

import argparse
import json
import os
import shutil

import torch
from safetensors import safe_open
from safetensors.torch import save_file
from sentencepiece import sentencepiece_model_pb2 as spm_pb
from transformers import AutoTokenizer

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CORPUS = [
    "training/data/prompts-built.jsonl",
    "training/data/mix-all/train.jsonl",
    "training/data/mix-all/valid.jsonl",
    "training/data/mix-all/test.jsonl",
]


def corpus_texts() -> list[str]:
    texts = []
    for rel in CORPUS:
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            continue
        for line in open(path, encoding="utf-8"):
            row = json.loads(line)
            if "messages" in row:
                texts.extend(m["content"] for m in row["messages"])
            else:
                texts.extend(str(v) for k, v in row.items() if k.startswith("prompt") or k == "request")
    return texts


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--spm", default=os.path.join(ROOT, "training/models/probe/gemma4-official.spm"))
    parser.add_argument("--out", required=True)
    parser.add_argument("--size", type=int, default=32768)
    parser.add_argument("--keep-low", type=int, default=1024)
    args = parser.parse_args()

    model = spm_pb.ModelProto()
    model.ParseFromString(open(args.spm, "rb").read())
    pieces = model.pieces
    full = len(pieces)

    tokenizer = AutoTokenizer.from_pretrained(args.base)
    used: set[int] = set()
    for text in corpus_texts():
        used.update(tokenizer(text, add_special_tokens=False)["input_ids"])
    keep = {i for i, p in enumerate(pieces) if p.type != spm_pb.ModelProto.SentencePiece.NORMAL}
    keep.update(range(args.keep_low))
    keep.update(used)
    print(f"non-normal + low + used: {len(keep)} pieces (used in corpus: {len(used)})")
    ranked = sorted((i for i, p in enumerate(pieces) if i not in keep), key=lambda i: -pieces[i].score)
    for i in ranked:
        if len(keep) >= args.size:
            break
        keep.add(i)
    kept = sorted(keep)
    old_to_new = {old: new for new, old in enumerate(kept)}
    print(f"kept {len(kept)} of {full} pieces; low ids unchanged: {all(old_to_new[i] == i for i in range(args.keep_low))}")

    os.makedirs(args.out, exist_ok=True)
    pruned = spm_pb.ModelProto()
    pruned.CopyFrom(model)
    del pruned.pieces[:]
    for old in kept:
        pruned.pieces.append(pieces[old])
    open(os.path.join(args.out, "tokenizer.spm"), "wb").write(pruned.SerializeToString())
    json.dump({"kept_old_ids": kept, "size": len(kept), "full": full}, open(os.path.join(args.out, "vocab-map.json"), "w"))

    index = torch.tensor(kept, dtype=torch.long)
    shard_files = sorted(f for f in os.listdir(args.base) if f.endswith(".safetensors"))
    weight_map: dict[str, str] = {}
    total = 0
    sliced = []
    for shard in shard_files:
        tensors = {}
        with safe_open(os.path.join(args.base, shard), "pt") as handle:
            for key in handle.keys():
                t = handle.get_tensor(key)
                dims = [d for d, n in enumerate(t.shape) if n == full]
                if dims:
                    t = t.index_select(dims[0], index)
                    sliced.append((key, dims[0], tuple(t.shape)))
                tensors[key] = t
                total += t.numel() * t.element_size()
        save_file(tensors, os.path.join(args.out, shard), metadata={"format": "pt"})
        for key in tensors:
            weight_map[key] = shard
        print(f"wrote {shard}")
    json.dump({"metadata": {"total_size": total}, "weight_map": weight_map}, open(os.path.join(args.out, "model.safetensors.index.json"), "w"), indent=2)
    print("sliced tensors:", sliced)

    config = json.load(open(os.path.join(args.base, "config.json")))
    def set_vocab(d: dict) -> None:
        for k in ("vocab_size", "vocab_size_per_layer_input"):
            if k in d:
                d[k] = len(kept)
    set_vocab(config)
    for sub in ("text_config",):
        if isinstance(config.get(sub), dict):
            set_vocab(config[sub])
    json.dump(config, open(os.path.join(args.out, "config.json"), "w"), indent=2)
    for name in ("generation_config.json", "tokenizer.json", "tokenizer_config.json", "chat_template.jinja", "processor_config.json", "special_tokens_map.json"):
        src = os.path.join(args.base, name)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(args.out, name))
    print(f"done: {args.out} (vocab {len(kept)})")


if __name__ == "__main__":
    main()
