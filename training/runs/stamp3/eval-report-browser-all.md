| model | n | valid JSON | strict pass | rendered | first-try no loss | median adjustments | median nodes | median s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| exam-stock.jsonl | 58 | 4 | 1 | 57 | 38 | 6 | 15 | 12.4 |
| exam-tuned-3ep.jsonl | 58 | 46 | 43 | 58 | 35 | 2 | 17 | 21.4 |
| exam-tuned-2ep.jsonl | 58 | 50 | 50 | 58 | 38 | 2 | 17 | 20.6 |

Showcase prompts:
- sourdough starter: fermentation: exam-stock.jsonl: 27 nodes, 6 adj, node loss · exam-tuned-3ep.jsonl: 22 nodes, 5 adj · exam-tuned-2ep.jsonl: 19 nodes, 0 adj
- model rocket: exam-stock.jsonl: 41 nodes, 5 adj · exam-tuned-3ep.jsonl: 18 nodes, 0 adj · exam-tuned-2ep.jsonl: 17 nodes, 0 adj
- houseplant Gerald: exam-stock.jsonl: 23 nodes, 2 adj · exam-tuned-3ep.jsonl: 26 nodes, 0 adj · exam-tuned-2ep.jsonl: 19 nodes, 4 adj
- patient intake form: exam-stock.jsonl: 11 nodes, 2 adj · exam-tuned-3ep.jsonl: 14 nodes, 0 adj · exam-tuned-2ep.jsonl: 13 nodes, 0 adj
- customer support chat: exam-stock.jsonl: 8 nodes, 4 adj · exam-tuned-3ep.jsonl: 21 nodes, 10 adj, node loss · exam-tuned-2ep.jsonl: 12 nodes, 0 adj
- status dashboard for a website: exam-stock.jsonl: 9 nodes, 8 adj · exam-tuned-3ep.jsonl: 14 nodes, 0 adj · exam-tuned-2ep.jsonl: 18 nodes, 0 adj
- account settings page: exam-stock.jsonl: 16 nodes, 4 adj · exam-tuned-3ep.jsonl: 17 nodes, 0 adj · exam-tuned-2ep.jsonl: 18 nodes, 6 adj, node loss
- checkout review screen for a small web shop: exam-stock.jsonl: 25 nodes, 17 adj, node loss · exam-tuned-3ep.jsonl: 34 nodes, 4 adj · exam-tuned-2ep.jsonl: 23 nodes, 3 adj
