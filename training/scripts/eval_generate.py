#!/usr/bin/env python3
"""Generate compositions for the held-out prompts with a base or fine-tuned model on MLX.

    training/.venv/bin/python training/scripts/eval_generate.py --out training/runs/eval-base.jsonl
    training/.venv/bin/python training/scripts/eval_generate.py --adapter-path training/runs/mix-all/adapters --out training/runs/eval-mix-all.jsonl

Greedy decoding, the same system message the app sends to LiteRT, the exact production prompt as the
user turn. Outputs are raw text; scoring happens in eval-replay.test.ts through the real guardrail.
"""
import argparse
import json
import os
import time
from pathlib import Path

from mlx_lm import generate, load
from mlx_lm.sample_utils import make_sampler

ROOT = Path(__file__).resolve().parents[2]
SYSTEM = "Follow the output format exactly. Never emit executable code."


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=str(ROOT / "training/models/gemma-4-E2B-it-text"))
    parser.add_argument("--adapter-path", default=None)
    parser.add_argument("--split", default="eval")
    parser.add_argument("--prompts", default=str(ROOT / "training/data/prompts-built.jsonl"))
    parser.add_argument("--out", required=True)
    parser.add_argument("--max-tokens", type=int, default=1800)
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    rows = [json.loads(line) for line in Path(args.prompts).read_text().splitlines() if line.strip()]
    rows = [row for row in rows if row["split"] == args.split][: args.limit]
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    done = set()
    if out_path.exists():
        done = {json.loads(line)["id"] for line in out_path.read_text().splitlines() if line.strip()}
    todo = [row for row in rows if row["id"] not in done]
    print(f"{len(todo)} prompts to generate ({len(done)} already done) with {args.model} adapters={args.adapter_path}", flush=True)

    model, tokenizer = load(args.model, adapter_path=args.adapter_path)
    sampler = make_sampler(temp=0.0)
    with out_path.open("a") as sink:
        for index, row in enumerate(todo, 1):
            messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": row["prompt_litert"]}]
            # No thinking channel: LiteRT in the browser answers directly, and so must this baseline and the fine-tune.
            prompt = tokenizer.apply_chat_template(messages, add_generation_prompt=True, tokenize=False, enable_thinking=False)
            started = time.time()
            text = generate(model, tokenizer, prompt=prompt, max_tokens=args.max_tokens, sampler=sampler, verbose=False)
            seconds = round(time.time() - started, 1)
            sink.write(json.dumps({"id": row["id"], "family": row["family"], "request": row["request"], "model": args.model, "adapter": args.adapter_path, "output": text, "seconds": seconds}) + "\n")
            sink.flush()
            print(f"  {index}/{len(todo)} {row['id']} {seconds}s {len(text)} chars", flush=True)


if __name__ == "__main__":
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    main()
