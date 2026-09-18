"""Generate the held-out prompts with a vocabulary-pruned checkpoint on MLX.

The pruned model's ids are positions in vocab-map.json's kept list; the tokenizer in the
directory is still the full one, so prompt ids are mapped old->new before the model and
new->old before decoding. Writes eval-replay rows.
    training/.venv/bin/python training/scripts/eval_pruned.py --model training/runs/mix-all/fused-hf-v32k --out training/runs/eval-pruned-v32k.jsonl
"""
import argparse
import json
import os
import time
from pathlib import Path

import mlx.core as mx
from mlx_lm.tokenizer_utils import load as load_tokenizer
from mlx_lm.utils import load_model
from mlx_lm.generate import generate_step
from mlx_lm.sample_utils import make_sampler

ROOT = Path(__file__).resolve().parents[2]
SYSTEM = "Follow the output format exactly. Never emit executable code."
STOP = {1, 106}  # <eos>, <turn|>


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--ids", default="p114,p301,p302,p303,p453,p455")
    parser.add_argument("--prompts", default=str(ROOT / "training/data/prompts-built.jsonl"))
    parser.add_argument("--max-tokens", type=int, default=1800)
    args = parser.parse_args()
    kept = json.load(open(Path(args.model) / "vocab-map.json"))["kept_old_ids"]
    old_to_new = {old: new for new, old in enumerate(kept)}
    rows = {json.loads(l)["id"]: json.loads(l) for l in Path(args.prompts).read_text().splitlines() if l.strip()}
    out_path = Path(args.out)
    done = {json.loads(l)["id"] for l in out_path.read_text().splitlines() if l.strip()} if out_path.exists() else set()
    model, _config = load_model(Path(args.model), strict=False)  # the HF checkpoint carries 60 unused k/v tensors
    tokenizer = load_tokenizer(Path(args.model))
    sampler = make_sampler(temp=0.0)
    with out_path.open("a") as sink:
        for pid in args.ids.split(","):
            if pid in done:
                continue
            row = rows[pid]
            messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": row["prompt_litert"]}]
            text = tokenizer.apply_chat_template(messages, add_generation_prompt=True, tokenize=False, enable_thinking=False)
            old_ids = tokenizer.encode(text, add_special_tokens=False)
            missing = [i for i in old_ids if i not in old_to_new]
            if missing:
                print(f"  {pid}: {len(missing)} prompt tokens fell outside the pruned vocabulary, e.g. {tokenizer.convert_ids_to_tokens(missing[:5])}")
            prompt = mx.array([old_to_new.get(i, old_to_new[3]) for i in old_ids])  # unknown -> <unk>
            started = time.time()
            produced = []
            for (token, _), _n in zip(generate_step(prompt, model, sampler=sampler, max_tokens=args.max_tokens), range(args.max_tokens)):
                old = kept[int(token)]
                if old in STOP:
                    break
                produced.append(old)
            output = tokenizer.decode(produced)
            seconds = round(time.time() - started, 1)
            sink.write(json.dumps({"id": pid, "request": row["request"], "model": args.model, "output": output, "seconds": seconds}) + "\n")
            sink.flush()
            print(f"  {pid} {seconds}s {len(output)} chars {output[:100]!r}", flush=True)


if __name__ == "__main__":
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    main()
