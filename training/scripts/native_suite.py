"""Run held-out prompts through a .litertlm file natively (Google's Python SDK, CPU)
and write rows the eval replay scorer understands: {id, request, output, seconds}."""
import json, sys, time
import litert_lm
model, out_path, ids = sys.argv[1], sys.argv[2], sys.argv[3].split(',')
rows = {r['id']: r for r in (json.loads(l) for l in open('training/data/prompts-built.jsonl'))}
done = set()
try:
    for l in open(out_path):
        done.add(json.loads(l)['id'])
except FileNotFoundError:
    pass
engine = litert_lm.Engine(model, backend=litert_lm.Backend.CPU(), max_num_tokens=4096)
with open(out_path, 'a') as out:
    for pid in ids:
        if pid in done:
            continue
        row = rows[pid]
        conv = engine.create_conversation(system_message='Follow the output format exactly. Never emit executable code.')
        t0 = time.time()
        res = conv.send_message(row['prompt_litert'])
        text = ''.join(p.get('text', '') for p in res['content']) if isinstance(res, dict) else str(res)
        seconds = round(time.time() - t0, 1)
        conv.close()
        out.write(json.dumps({'id': pid, 'request': row['request'], 'output': text, 'seconds': seconds}) + '\n')
        out.flush()
        print(f'[{pid}] {seconds}s {len(text)} chars: {text[:120]!r}', flush=True)
engine.close()
