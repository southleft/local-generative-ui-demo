/**
 * Re-id the training targets with content-derived ids.
 *
 * The assembled targets never contain a duplicate id, but their ids are a tiny
 * counter vocabulary (heading1 in 387 of 688 pages) and the fine-tuned model
 * collides on exactly that habit on long pages. This rewrites every target so
 * an id is the component's type plus a slug of its label/title/text (a
 * container takes its first child's slug), unique within the page, and leaves
 * the prompts untouched. Output: training/data/mix-all-ids/{train,valid,test}.jsonl.
 *
 *   npx vitest run training/scripts/reid-targets.test.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseCompositionStrict } from '../../src/salvage';

const SRC = 'training/data/mix-all';
const DST = 'training/data/mix-all-ids';
const TEXT_KEYS = ['title', 'label', 'text', 'name', 'placeholder', 'value'];

type Component = Record<string, unknown> & { id: string; component: string; children?: string[] };

function words(value: string): string[] {
  return value.normalize('NFKD').replace(/[^A-Za-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 4);
}

function capitalise(word: string): string {
  return word[0].toUpperCase() + word.slice(1).toLowerCase();
}

function textSlug(component: Component): string | undefined {
  for (const key of TEXT_KEYS) {
    const direct = component[key];
    const nested = (component.props as Record<string, unknown> | undefined)?.[key];
    const value = typeof direct === 'string' ? direct : typeof nested === 'string' ? nested : undefined;
    if (value?.trim()) {
      const parts = words(value);
      if (parts.length) return parts.map(capitalise).join('');
    }
  }
  return undefined;
}

export function reidTarget(target: string): string {
  const doc = JSON.parse(target) as { root: string; components: Component[] };
  const byId = new Map(doc.components.map((c) => [c.id, c]));
  const slugOf = new Map<string, string>(); // old id -> slug part (no type prefix)
  const newId = new Map<string, string>();
  const taken = new Set<string>();

  const typePrefix = (c: Component) => c.component[0].toLowerCase() + c.component.slice(1);
  const claim = (candidate: string) => {
    let id = candidate;
    for (let n = 2; taken.has(id); n += 1) id = `${candidate}${n}`;
    taken.add(id);
    return id;
  };

  // Root keeps its conventional id.
  const root = byId.get(doc.root);
  if (root) {
    newId.set(root.id, 'root');
    slugOf.set(root.id, '');
    taken.add('root');
  }
  // Name components whose children are already named, until nothing changes.
  let progress = true;
  while (progress) {
    progress = false;
    for (const c of doc.components) {
      if (newId.has(c.id)) continue;
      const kids = Array.isArray(c.children) ? c.children.filter((k) => byId.has(k)) : [];
      if (kids.some((k) => !slugOf.has(k))) continue;
      const own = textSlug(c);
      const slug = own ?? (kids.length ? slugOf.get(kids[0]) ?? '' : '');
      slugOf.set(c.id, slug);
      newId.set(c.id, claim(typePrefix(c) + slug));
      progress = true;
    }
  }
  // Anything left (reference cycles) keeps a type-based id.
  for (const c of doc.components) {
    if (!newId.has(c.id)) newId.set(c.id, claim(typePrefix(c)));
  }
  for (const c of doc.components) {
    c.id = newId.get(c.id)!;
    if (Array.isArray(c.children)) c.children = c.children.map((k) => newId.get(k) ?? k);
  }
  doc.root = newId.get(doc.root) ?? doc.root;
  return JSON.stringify(doc);
}

it('re-ids every target with content-derived ids that still pass the strict parser', () => {
  if (!existsSync(`${SRC}/train.jsonl`)) return;
  mkdirSync(DST, { recursive: true });
  const idCounts = new Map<string, number>();
  let rows = 0;
  for (const split of ['train', 'valid', 'test']) {
    const path = `${SRC}/${split}.jsonl`;
    if (!existsSync(path)) continue;
    const out: string[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
      const row = JSON.parse(line) as { messages: Array<{ role: string; content: string }> };
      const assistant = row.messages.find((m) => m.role === 'assistant')!;
      const before = JSON.parse(assistant.content) as { components: Component[] };
      const after = reidTarget(assistant.content);
      const parsed = JSON.parse(after) as { components: Component[] };
      expect(parsed.components.length).toBe(before.components.length);
      expect(new Set(parsed.components.map((c) => c.id)).size).toBe(parsed.components.length);
      expect(() => parseCompositionStrict(after)).not.toThrow();
      for (const c of parsed.components) idCounts.set(c.id, (idCounts.get(c.id) ?? 0) + 1);
      assistant.content = after;
      out.push(JSON.stringify(row));
      rows += 1;
    }
    writeFileSync(`${DST}/${split}.jsonl`, `${out.join('\n')}\n`);
  }
  const top = [...idCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const shared = [...idCounts.values()].filter((n) => n >= 20).length;
  writeFileSync(`${DST}/manifest.json`, JSON.stringify({ source: SRC, rows, distinctIds: idCounts.size, idsSharedBy20PlusPages: shared, top }, null, 1));
  console.log(`re-id'd ${rows} rows: ${idCounts.size} distinct ids, ${shared} shared by 20+ pages; top ${JSON.stringify(top)}`);
  expect(rows).toBeGreaterThan(0);
});

it('derives ids from content and keeps the root', () => {
  const target = JSON.stringify({ root: 'root', components: [
    { props: { accent: 'amber' }, id: 'root', component: 'Page', children: ['heading1', 'inline1'] },
    { text: 'Car Maintenance Log', level: 'h1', icon: '🚗', id: 'heading1', component: 'Heading' },
    { align: 'center', id: 'inline1', component: 'Inline', children: ['statusbadge1', 'tag1', 'tag2'] },
    { label: 'Service Due Soon', tone: 'warning', id: 'statusbadge1', component: 'StatusBadge' },
    { label: 'Oil', id: 'tag1', component: 'Tag' },
    { label: 'Oil', id: 'tag2', component: 'Tag' },
  ] });
  const parsed = JSON.parse(reidTarget(target)) as { root: string; components: Component[] };
  expect(parsed.root).toBe('root');
  expect(parsed.components.map((c) => c.id)).toEqual(['root', 'headingCarMaintenanceLog', 'inlineServiceDueSoon', 'statusBadgeServiceDueSoon', 'tagOil', 'tagOil2']);
  expect(parsed.components[0].children).toEqual(['headingCarMaintenanceLog', 'inlineServiceDueSoon']);
  expect(Object.keys(parsed.components[1])).toEqual(['text', 'level', 'icon', 'id', 'component']);
});
