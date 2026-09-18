"""Fake-quantize chosen weights of the fused MLX model exactly the way ai_edge_quantizer
does at export (symmetric min/max, per output channel or per block, int4 range [-8, 7],
int8 narrow range [-127, 127]; scale = max|w| / qmax) and generate the held-out prompts.

Lets us find which tensors survive which precision in minutes on MLX instead of a
seven-minute litert-torch export per guess. Usage:
    training/.venv/bin/python training/scripts/eval_fakequant.py --config fc4 --out training/runs/eval-fq-fc4.jsonl --ids p114,p301
Configs (see CONFIGS): a name -> list of (regex over weight path, bits, granularity).
Rules are applied in order; the last matching rule wins; bits=None leaves the tensor alone.
"""
import argparse
import json
import os
import re
import time
from pathlib import Path

import mlx.core as mx
from mlx.utils import tree_flatten, tree_unflatten
from mlx_lm import generate, load
from mlx_lm.sample_utils import make_sampler

ROOT = Path(__file__).resolve().parents[2]
SYSTEM = "Follow the output format exactly. Never emit executable code."
FC = r"layers\.\d+\.(self_attn\.[qkvo]_proj|mlp\.(gate|up|down)_proj|per_layer_input_gate|per_layer_projection)\.weight$"
LORA = r"layers\.(19|2\d|3[0-4])\.self_attn\.[qo]_proj\.weight$"
EMB = r"embed_tokens\.weight$"
MLP = r"layers\.\d+\.mlp\.(gate|up|down)_proj\.weight$"
PLE = r"embed_tokens_per_layer\.weight$"
CONFIGS = {
    "fc4": [(FC, 4, "channel")],                                   # what dynamic_wi4_afp32 does to the decoder
    "fc4emb4": [(FC, 4, "channel"), (EMB, 4, "channel"), (PLE, 4, "channel")],  # the whole channelwise int4 export
    "fc4b32": [(FC, 4, "block32")],                                # the blockwise export's decoder
    "fc8emb4": [(FC, 8, "channel"), (EMB, 4, "channel"), (PLE, 4, "channel")],  # int8 decoder, int4 tables
    "fc8emb4ple2": [(FC, 8, "channel"), (EMB, 4, "channel"), (PLE, 2, "channel")],
    "fc4lora8": [(FC, 4, "channel"), (LORA, 8, "channel")],       # int4 everywhere except the 32 tuned tensors
    "fc4b32lora8": [(FC, 4, "block32"), (LORA, 8, "channel")],
    "fc8": [(FC, 8, "channel")],
    "mlp4": [(FC, 8, "channel"), (MLP, 4, "channel")],            # int8 attention, int4 MLP
    "mlp4b32": [(FC, 8, "channel"), (MLP, 4, "block32")],
    "fc8emb2ple4": [(FC, 8, "channel"), (EMB, 2, "channel"), (PLE, 4, "channel")],
    "fc8emb4ple4b32": [(FC, 8, "channel"), (EMB, 4, "channel"), (PLE, 4, "block32")],
    "none": [],
}


def fake_quant(w: mx.array, bits: int, granularity: str) -> mx.array:
    qmax = 2 ** (bits - 1) - 1
    qmin = -qmax if bits >= 8 else -(2 ** (bits - 1))  # narrow range only at >= 8 bits (quantizer rule)
    x = w.astype(mx.float32)
    if granularity == "channel":
        bound = mx.maximum(mx.max(mx.abs(x), axis=1, keepdims=True), 1e-9)
        scale = bound / qmax
        q = mx.clip(mx.round(x / scale), qmin, qmax)
        return (q * scale).astype(w.dtype)
    block = int(granularity.replace("block", ""))
    out_dim, in_dim = x.shape
    assert in_dim % block == 0, (x.shape, block)
    xb = x.reshape(out_dim, in_dim // block, block)
    bound = mx.maximum(mx.max(mx.abs(xb), axis=2, keepdims=True), 1e-9)
    scale = (bound / qmax).astype(mx.float16).astype(mx.float32)  # blockwise scales are stored as float16
    q = mx.clip(mx.round(xb / scale), qmin, qmax)
    return (q * scale).reshape(out_dim, in_dim).astype(w.dtype)


def apply_config(model, rules):
    flat = dict(tree_flatten(model.parameters()))
    changed = {}
    counts = {}
    for path, w in flat.items():
        chosen = None
        for pattern, bits, gran in rules:
            if re.search(pattern, path):
                chosen = (bits, gran)
        if chosen is None or chosen[0] is None or w.ndim != 2:
            continue
        changed[path] = fake_quant(w, *chosen)
        counts[chosen] = counts.get(chosen, 0) + 1
    if changed:
        model.update(tree_unflatten(list(changed.items())))
        mx.eval(model.parameters())
    return counts


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=str(ROOT / "training/runs/mix-all/fused"))
    parser.add_argument("--config", required=True, choices=sorted(CONFIGS))
    parser.add_argument("--out", required=True)
    parser.add_argument("--ids", default="p114,p301,p302,p303,p453,p455")
    parser.add_argument("--prompts", default=str(ROOT / "training/data/prompts-built.jsonl"))
    parser.add_argument("--max-tokens", type=int, default=1800)
    args = parser.parse_args()
    ids = args.ids.split(",")
    rows = {json.loads(l)["id"]: json.loads(l) for l in Path(args.prompts).read_text().splitlines() if l.strip()}
    out_path = Path(args.out)
    done = {json.loads(l)["id"] for l in out_path.read_text().splitlines() if l.strip()} if out_path.exists() else set()
    model, tokenizer = load(args.model)
    counts = apply_config(model, CONFIGS[args.config])
    print(f"config {args.config}: fake-quantized {counts}", flush=True)
    sampler = make_sampler(temp=0.0)
    with out_path.open("a") as sink:
        for pid in ids:
            if pid in done:
                continue
            row = rows[pid]
            messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": row["prompt_litert"]}]
            prompt = tokenizer.apply_chat_template(messages, add_generation_prompt=True, tokenize=False, enable_thinking=False)
            started = time.time()
            text = generate(model, tokenizer, prompt=prompt, max_tokens=args.max_tokens, sampler=sampler, verbose=False)
            seconds = round(time.time() - started, 1)
            sink.write(json.dumps({"id": pid, "request": row["request"], "config": args.config, "output": text, "seconds": seconds}) + "\n")
            sink.flush()
            print(f"  {pid} {seconds}s {len(text)} chars {text[:100]!r}", flush=True)


if __name__ == "__main__":
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    main()
