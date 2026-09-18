import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { z } from 'zod';
import { catalog, componentNames, type ComponentName } from '../../src/catalog';
import { parseCompositionStrict } from '../../src/salvage';

/**
 * Catalog set: micro-examples generated straight from the component schemas,
 * correct by construction and validated by the strict parser before they are
 * written. One example per enum value of every prop, plus convention examples
 * for the things small models get wrong (bindings only on inputs, actions only
 * on Button, children by id, a root that names a real Page).
 *
 *   npx vitest run training/scripts/catalog-set.test.ts
 */
const OUT = `${process.cwd()}/training/data/catalog-set.jsonl`;

let seed = 4242;
const rand = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];

const contexts = ['a bakery', 'a bike shop', 'a clinic', 'a yoga studio', 'a coffee roaster', 'a bookstore', 'a climbing gym', 'a film festival', 'a food bank', 'a music school', 'a plumbing company', 'a ferry service', 'an astronomy club', 'a tea house', 'a comic shop'];
const headings = ['Weekly summary', 'Order details', 'Team status', 'Account', 'Schedule', 'Inventory', 'Overview', 'Next steps', 'Feedback', 'Bookings'];
const sentences = ['Everything is on track for Friday.', 'Two items are waiting on approval.', 'Please review before submitting.', 'Updated ten minutes ago.', 'No changes since yesterday.', 'Contact the front desk with questions.'];
const labels = ['Revenue', 'Open tickets', 'Members', 'Bookings', 'Orders today', 'Wait time', 'Stock on hand', 'Uptime'];
const values = ['$12,400', '38', '1,204', '92%', '14 min', '73', '$3,980', '99.9%'];
const details = ['vs. last week', 'of $20,000', 'target 40', 'past 30 days', 'since 8am', 'needs attention'];
const buttonLabels = ['Save changes', 'Export report', 'Book now', 'Send message', 'Place order', 'View board', 'Add item', 'Confirm'];
const fieldLabels = ['Full name', 'Email address', 'Phone number', 'Preferred date', 'Notes', 'Company', 'Street address', 'Reason for visit'];
const tags = ['Design', 'Development', 'Urgent', 'New', 'Approved', 'Weekend', 'Vegan', 'Beginner'];

type Node = Record<string, unknown> & { id: string; component: ComponentName };
const rows: Array<{ id: string; family: 'catalog'; split: 'train'; request: string; target: string; component: ComponentName; prop?: string; value?: string }> = [];
const camel = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+(.)/g, (_, c: string) => c.toUpperCase()).replace(/[^a-zA-Z0-9]/g, '');
const pageAccent = () => pick(['indigo', 'violet', 'sky', 'teal', 'emerald', 'amber', 'rose', 'slate'] as const);

/** Wrap leaves in a Page (the root) with a heading, in A2UI component syntax. */
const surface = (title: string, nodes: Node[], extraChildren: string[] = []): string => {
  const page: Node = { id: 'root', component: 'Page', accent: pageAccent(), children: ['title', ...nodes.filter((n) => !extraChildren.includes(n.id)).map((n) => n.id)] };
  const heading: Node = { id: 'title', component: 'Heading', text: title, level: 'h1' };
  return JSON.stringify({ root: 'root', components: [page, heading, ...nodes] });
};
const add = (component: ComponentName, request: string, target: string, prop?: string, value?: string) => {
  const parsed = parseCompositionStrict(target);
  const { composition, warnings } = parsed;
  if (warnings.length) throw new Error(`catalog example needs salvage: ${warnings.join(' | ')}\n${target}`);
  if (!composition.nodes.some((n) => n.component === component)) throw new Error(`example lost its ${component}`);
  rows.push({ id: `c${String(rows.length + 1).padStart(3, '0')}`, family: 'catalog', split: 'train', request, target, component, prop, value });
};

const unwrap = (s: z.ZodTypeAny): z.ZodTypeAny => { let d = (s as { _def: { typeName?: string; innerType?: z.ZodTypeAny } })._def; let cur = s; while (d && ['ZodOptional', 'ZodDefault', 'ZodNullable'].includes(d.typeName ?? '') && d.innerType) { cur = d.innerType; d = (cur as { _def: typeof d })._def; } return cur; };
const enumValues = (s: z.ZodTypeAny): (string | number)[] | undefined => { const u = unwrap(s); const d = (u as { _def: { typeName?: string; values?: string[]; options?: z.ZodTypeAny[]; value?: string | number } })._def; if (d.typeName === 'ZodEnum') return d.values; if (d.typeName === 'ZodUnion' && d.options?.every((o) => (o as { _def: { typeName?: string } })._def.typeName === 'ZodLiteral')) return d.options.map((o) => (o as { _def: { value: string | number } })._def.value); return undefined; };

it('generates the catalog set', () => {
  for (const name of componentNames) {
    const entry = catalog[name];
    const shape = (entry.schema as unknown as { _def: { shape: () => Record<string, z.ZodTypeAny> } })._def.shape();
    for (const [prop, schema] of Object.entries(shape)) {
      const options = enumValues(schema);
      if (!options) continue;
      for (const value of options) {
        const ctx = pick(contexts);
        const v = String(value);
        switch (name) {
          case 'Page': add(name, `A page for ${ctx} with a ${v} accent, a heading, and one line of text.`, JSON.stringify({ root: 'root', components: [{ id: 'root', component: 'Page', accent: v, children: ['title', 'copy'] }, { id: 'title', component: 'Heading', text: pick(headings), level: 'h1' }, { id: 'copy', component: 'Text', text: pick(sentences) }] }), prop, v); break;
          case 'Stack': add(name, `A vertical stack with ${v} spacing holding two short paragraphs, for ${ctx}.`, surface(pick(headings), [{ id: 'stack', component: 'Stack', gap: v, children: ['p1', 'p2'] }, { id: 'p1', component: 'Text', text: pick(sentences) }, { id: 'p2', component: 'Text', text: pick(sentences) }], ['p1', 'p2']), prop, v); break;
          case 'Inline': { const nodes: Node[] = [{ id: 'row', component: 'Inline', [prop]: v, children: ['b1', 'b2'] }, { id: 'b1', component: 'Button', label: 'Cancel', tone: 'secondary', action: { event: { name: 'cancel' } } }, { id: 'b2', component: 'Button', label: pick(buttonLabels), tone: 'primary', action: { event: { name: 'confirm' } } }]; add(name, `A row of two buttons with ${prop} set to ${v}, for ${ctx}.`, surface(pick(headings), nodes, ['b1', 'b2']), prop, v); break; }
          case 'Grid': { const n = Number(v); const metrics: Node[] = Array.from({ length: n }, (_, i) => ({ id: `m${i + 1}`, component: 'Metric', label: labels[i % labels.length], value: values[i % values.length], tone: 'neutral' })); add(name, `A ${n}-column grid of ${n} metrics for ${ctx}.`, surface(pick(headings), [{ id: 'grid', component: 'Grid', columns: n, children: metrics.map((m) => m.id) }, ...metrics], metrics.map((m) => m.id)), prop, v); break; }
          case 'Card': add(name, `A ${v} card for ${ctx} with a heading and a sentence.`, surface(pick(headings), [{ id: 'card', component: 'Card', tone: v, children: ['h2', 'copy'] }, { id: 'h2', component: 'Heading', text: pick(headings), level: 'h3' }, { id: 'copy', component: 'Text', text: pick(sentences) }], ['h2', 'copy']), prop, v); break;
          case 'Heading': add(name, `A ${v} heading that reads "${pick(headings)}" above one line of text, for ${ctx}.`, JSON.stringify({ root: 'root', components: [{ id: 'root', component: 'Page', accent: pageAccent(), children: ['h', 'copy'] }, { id: 'h', component: 'Heading', text: pick(headings), level: v }, { id: 'copy', component: 'Text', text: pick(sentences) }] }), prop, v); break;
          case 'Text': add(name, `A ${v} note under a heading, for ${ctx}.`, surface(pick(headings), [{ id: 'note', component: 'Text', text: pick(sentences), tone: v }]), prop, v); break;
          case 'ChatBubble': add(name, `One chat message from the ${v} side, for ${ctx}.`, surface('Conversation', [{ id: 'msg', component: 'ChatBubble', text: pick(sentences), from: v, name: v === 'user' ? 'You' : 'Agent' }]), prop, v); break;
          case 'Metric': add(name, `A ${v} metric showing ${pick(labels).toLowerCase()} for ${ctx}.`, surface(pick(headings), [{ id: 'metric', component: 'Metric', label: pick(labels), value: pick(values), detail: pick(details), tone: v }]), prop, v); break;
          case 'StatusBadge': add(name, `A ${v} status badge for ${ctx}.`, surface(pick(headings), [{ id: 'badge', component: 'StatusBadge', label: pick(['On track', 'At risk', 'Blocked', 'Done']), tone: v }]), prop, v); break;
          case 'Tag': add(name, `A ${v} tag reading "${pick(tags)}" for ${ctx}.`, surface(pick(headings), [{ id: 'tag', component: 'Tag', label: pick(tags), tone: v }]), prop, v); break;
          case 'ProgressBar': add(name, `A ${v} progress bar at ${40 + Math.floor(rand() * 50)} percent for ${ctx}.`, surface(pick(headings), [{ id: 'bar', component: 'ProgressBar', label: pick(['Project completion', 'Goal', 'Capacity']), percent: 40 + Math.floor(rand() * 50), tone: v }]), prop, v); break;
          case 'Alert': add(name, `A ${v} alert for ${ctx} with a title and a message.`, surface(pick(headings), [{ id: 'alert', component: 'Alert', title: pick(['Heads up', 'Action needed', 'All clear', 'Blocked']), message: pick(sentences), tone: v }]), prop, v); break;
          case 'TextField': add(name, `A single ${v} field labelled "${pick(fieldLabels)}" bound to state, for ${ctx}.`, surface(pick(headings), [{ id: 'field', component: 'TextField', label: pick(fieldLabels), placeholder: 'Type here', inputType: v, value: { path: `/state/${v}Field` } }]), prop, v); break;
          case 'Button': add(name, `A ${v} button labelled "${pick(buttonLabels)}" with an action, for ${ctx}.`, surface(pick(headings), [{ id: 'btn', component: 'Button', label: pick(buttonLabels), tone: v, action: { event: { name: camel(pick(buttonLabels)) } } }]), prop, v); break;
          default: break;
        }
      }
    }
  }
  // Components without enum props, and the conventions.
  add('Divider', 'Two paragraphs separated by a divider.', surface(pick(headings), [{ id: 'p1', component: 'Text', text: pick(sentences) }, { id: 'hr', component: 'Divider' }, { id: 'p2', component: 'Text', text: pick(sentences) }]));
  add('TextArea', 'A multi-line notes field bound to state with a submit button.', surface('Notes', [{ id: 'notes', component: 'TextArea', label: 'Notes', placeholder: 'Anything we should know?', value: { path: '/state/notes' } }, { id: 'send', component: 'Button', label: 'Submit', tone: 'primary', action: { event: { name: 'submitNotes' } } }]));
  add('Select', 'A dropdown to choose a shipping method, bound to state.', surface('Shipping', [{ id: 'ship', component: 'Select', label: 'Shipping method', options: [{ label: 'Standard', value: 'standard' }, { label: 'Express', value: 'express' }, { label: 'Pickup', value: 'pickup' }], value: { path: '/state/shippingMethod' } }]));
  for (let i = 0; i < 12; i++) {
    const ctx = pick(contexts);
    const fields = [pick(fieldLabels), pick(fieldLabels), pick(fieldLabels)].filter((f, idx, all) => all.indexOf(f) === idx);
    const nodes: Node[] = [{ id: 'card', component: 'Card', tone: 'default', children: fields.map((_, k) => `f${k}`) }, ...fields.map((f, k): Node => ({ id: `f${k}`, component: 'TextField', label: f, value: { path: `/form/${camel(f)}` } })), { id: 'actions', component: 'Inline', justify: 'end', children: ['cancel', 'submit'] }, { id: 'cancel', component: 'Button', label: 'Cancel', tone: 'secondary', action: { event: { name: 'cancel' } } }, { id: 'submit', component: 'Button', label: 'Submit', tone: 'primary', action: { event: { name: 'submitForm' } } }];
    add('Card', `A short form for ${ctx} with ${fields.map((f) => f.toLowerCase()).join(', ')} in one card and cancel/submit buttons.`, surface(pick(['Sign up', 'Contact us', 'Request a quote', 'Book a visit']), nodes, nodes.filter((n) => n.id !== 'card' && n.id !== 'actions').map((n) => n.id)));
  }
  for (let i = 0; i < 12; i++) {
    const ctx = pick(contexts);
    const metrics: Node[] = [0, 1, 2].map((k): Node => ({ id: `m${k}`, component: 'Metric', label: labels[(i + k) % labels.length], value: values[(i + k) % values.length], tone: pick(['neutral', 'success', 'warning'] as const) }));
    const nodes: Node[] = [{ id: 'grid', component: 'Grid', columns: 3, children: metrics.map((m) => m.id) }, ...metrics, { id: 'bar', component: 'ProgressBar', label: 'Quarter goal', percent: 30 + i * 5, tone: 'success' }, { id: 'alert', component: 'Alert', title: 'Blocked', message: pick(sentences), tone: 'critical' }, { id: 'actions', component: 'Inline', children: ['view', 'export'] }, { id: 'view', component: 'Button', label: 'View board', tone: 'primary', action: { event: { name: 'viewBoard' } } }, { id: 'export', component: 'Button', label: 'Export report', tone: 'secondary', action: { event: { name: 'exportReport' } } }];
    add('Grid', `A status dashboard for ${ctx}: three metrics in a grid, a goal progress bar, a blocker alert, and view/export buttons.`, surface(pick(['Status', 'Weekly report', 'Operations']), nodes, [...metrics.map((m) => m.id), 'view', 'export']));
  }
  writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const byComponent: Record<string, number> = {};
  for (const r of rows) byComponent[r.component] = (byComponent[r.component] ?? 0) + 1;
  console.log(`catalog set: ${rows.length} examples · ${Object.entries(byComponent).map(([k, v]) => `${k} ${v}`).join(', ')}`);
});
