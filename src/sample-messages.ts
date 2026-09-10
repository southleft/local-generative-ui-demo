import { buildA2uiMessages, type A2uiComponentNode, type A2uiMessage } from './a2ui-protocol';

export type ScenarioId = 'dashboard' | 'audit' | 'decision';

export const SCENARIOS: Record<ScenarioId, { label: string; prompt: string }> = {
  dashboard: { label: 'Dashboard', prompt: 'Create an account health dashboard with an overdue invoice, useful metrics, status, and clear next actions.' },
  audit: { label: 'Audit intake', prompt: 'Create a technical audit intake form with contact details, platform selection, context, and a submit action.' },
  decision: { label: 'Decision', prompt: 'Compare three implementation approaches, identify the recommendation and risks, then provide approve and revise actions.' },
};

const dashboard: A2uiComponentNode[] = [
  { id: 'root', component: 'Page', children: ['dashboardStack'] },
  { id: 'dashboardStack', component: 'Stack', gap: 'lg', children: ['heading', 'intro', 'metrics', 'accountCard', 'actions'] },
  { id: 'heading', component: 'Heading', text: 'Account health', level: 'h1' },
  { id: 'intro', component: 'Text', text: 'Your workspace is paused because the latest invoice is overdue. Nothing has been deleted.', tone: 'muted' },
  { id: 'metrics', component: 'Inline', justify: 'spaceBetween', align: 'stretch', children: ['balance', 'days', 'projects'] },
  { id: 'balance', component: 'Metric', label: 'Balance due', value: '$1,240', tone: 'critical' },
  { id: 'days', component: 'Metric', label: 'Overdue', value: '12 days', detail: 'Since July 2', tone: 'warning' },
  { id: 'projects', component: 'Metric', label: 'Projects', value: '8', detail: 'All data retained', tone: 'neutral' },
  { id: 'accountCard', component: 'Card', children: ['cardStack'] },
  { id: 'cardStack', component: 'Stack', gap: 'sm', children: ['statusRow', 'cardCopy'] },
  { id: 'statusRow', component: 'Inline', justify: 'spaceBetween', align: 'center', children: ['plan', 'status'] },
  { id: 'plan', component: 'Heading', text: 'Studio plan', level: 'h3' },
  { id: 'status', component: 'StatusBadge', label: 'Past due', tone: 'critical' },
  { id: 'cardCopy', component: 'Text', text: 'Pay the outstanding invoice to restore publishing and collaborator access immediately.' },
  { id: 'actions', component: 'Inline', align: 'center', children: ['pay', 'support'] },
  { id: 'pay', component: 'Button', label: 'Pay invoice', tone: 'primary', action: { event: { name: 'payInvoice', context: { invoiceId: 'INV-2048' } } } },
  { id: 'support', component: 'Button', label: 'Contact support', tone: 'secondary', action: { event: { name: 'contactSupport' } } },
];

const audit: A2uiComponentNode[] = [
  { id: 'root', component: 'Page', children: ['auditStack'] },
  { id: 'auditStack', component: 'Stack', gap: 'md', children: ['heading', 'intro', 'auditCard', 'submit'] },
  { id: 'heading', component: 'Heading', text: 'Technical audit intake', level: 'h1' },
  { id: 'intro', component: 'Text', text: 'Tell us enough to prepare a focused first pass. Your answers stay in this browser.', tone: 'muted' },
  { id: 'auditCard', component: 'Card', children: ['fields'] },
  { id: 'fields', component: 'Stack', gap: 'md', children: ['contact', 'platform', 'url'] },
  { id: 'contact', component: 'TextField', label: 'Work email', value: { path: '/form/email' }, placeholder: 'you@company.com', inputType: 'email' },
  { id: 'platform', component: 'Select', label: 'Primary platform', value: { path: '/form/platform' }, options: [{ label: 'React', value: 'react' }, { label: 'Next.js', value: 'next' }, { label: 'Other', value: 'other' }] },
  { id: 'url', component: 'TextField', label: 'Site URL', value: { path: '/form/url' }, placeholder: 'https://example.com', inputType: 'url' },
  { id: 'submit', component: 'Button', label: 'Submit audit request', tone: 'primary', action: { event: { name: 'submitAudit', context: { source: 'localExperiment' } } } },
];

const decision: A2uiComponentNode[] = [
  { id: 'root', component: 'Page', children: ['decisionStack'] },
  { id: 'decisionStack', component: 'Stack', gap: 'lg', children: ['heading', 'intro', 'recommendation', 'options', 'risk', 'actions'] },
  { id: 'heading', component: 'Heading', text: 'Choose the implementation path', level: 'h1' },
  { id: 'intro', component: 'Text', text: 'Three workable approaches, evaluated for speed, maintainability, and local-first constraints.', tone: 'muted' },
  { id: 'recommendation', component: 'StatusBadge', label: 'Recommended', tone: 'success' },
  { id: 'options', component: 'Inline', align: 'stretch', children: ['optionA', 'optionB', 'optionC'] },
  { id: 'optionA', component: 'Card', tone: 'recommended', children: ['optionAStack'] },
  { id: 'optionAStack', component: 'Stack', gap: 'sm', children: ['optionATitle', 'optionAText'] },
  { id: 'optionATitle', component: 'Heading', text: 'Shared catalog adapters', level: 'h3' },
  { id: 'optionAText', component: 'Text', text: 'One owned component library with narrow protocol adapters. Best balance of comparison quality and control.' },
  { id: 'optionB', component: 'Card', children: ['optionBStack'] },
  { id: 'optionBStack', component: 'Stack', gap: 'sm', children: ['optionBTitle', 'optionBText'] },
  { id: 'optionBTitle', component: 'Heading', text: 'Protocol-native catalogs', level: 'h3' },
  { id: 'optionBText', component: 'Text', text: 'Fastest initial integration, but visual and behavioral differences weaken the comparison.' },
  { id: 'optionC', component: 'Card', tone: 'muted', children: ['optionCStack'] },
  { id: 'optionCStack', component: 'Stack', gap: 'sm', children: ['optionCTitle', 'optionCText'] },
  { id: 'optionCTitle', component: 'Heading', text: 'Generated React', level: 'h3' },
  { id: 'optionCText', component: 'Text', text: 'Flexible, but violates the declarative safety boundary and is excluded.' },
  { id: 'risk', component: 'Alert', title: 'Key risk', message: 'Small models may produce structurally valid UI that still misses the user intent. Track usefulness separately from schema validity.', tone: 'warning' },
  { id: 'actions', component: 'Inline', align: 'center', children: ['approve', 'revise'] },
  { id: 'approve', component: 'Button', label: 'Approve recommendation', tone: 'primary', action: { event: { name: 'approveRecommendation', context: { option: 'sharedCatalogAdapters' } } } },
  { id: 'revise', component: 'Button', label: 'Revise criteria', tone: 'secondary', action: { event: { name: 'reviseCriteria' } } },
];

const componentsByScenario: Record<ScenarioId, A2uiComponentNode[]> = { dashboard, audit, decision };
const dataByScenario: Record<ScenarioId, Record<string, unknown>> = {
  dashboard: {},
  audit: { form: { email: '', platform: 'react', url: '' } },
  decision: {},
};

export function getA2uiSample(scenario: ScenarioId): A2uiMessage[] {
  return buildA2uiMessages(
    `sample.${scenario}`,
    structuredClone(componentsByScenario[scenario]),
    structuredClone(dataByScenario[scenario]),
  );
}
