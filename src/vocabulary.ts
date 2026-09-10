/**
 * Interpretation vocabulary: how off-catalog wording is read before strict
 * validation. Every table maps a lower-cased token the model might write to
 * the catalog value it most plausibly meant. The tables are data, surfaced
 * verbatim in the harness panel so the interpretation layer is inspectable.
 */

import type { ComponentName } from './catalog';

export const componentSynonyms: Record<string, ComponentName> = {
  title: 'Heading', header: 'Heading', heading: 'Heading', h1: 'Heading', h2: 'Heading', h3: 'Heading',
  paragraph: 'Text', label: 'Text', caption: 'Text', text: 'Text',
  chatbubble: 'ChatBubble', bubble: 'ChatBubble', chatmessage: 'ChatBubble', messagebubble: 'ChatBubble', speechbubble: 'ChatBubble',
  badge: 'StatusBadge', status: 'StatusBadge', statusbadge: 'StatusBadge',
  chip: 'Tag', tag: 'Tag', pill: 'Tag',
  progress: 'ProgressBar', progressbar: 'ProgressBar', progressindicator: 'ProgressBar', meter: 'ProgressBar',
  input: 'TextField', textinput: 'TextField', textfield: 'TextField', field: 'TextField',
  textarea: 'TextArea', multilinetext: 'TextArea', multilineinput: 'TextArea',
  dropdown: 'Select', select: 'Select', picker: 'Select',
  row: 'Inline', inline: 'Inline', columns: 'Grid', grid: 'Grid',
  container: 'Stack', box: 'Stack', section: 'Stack', column: 'Stack', stack: 'Stack', list: 'Stack',
  separator: 'Divider', rule: 'Divider', divider: 'Divider', hr: 'Divider',
  banner: 'Alert', notice: 'Alert', callout: 'Alert', alert: 'Alert',
  page: 'Page', card: 'Card', metric: 'Metric', stat: 'Metric', kpi: 'Metric', button: 'Button',
};

export const semanticToneSynonyms: Record<string, string> = {
  info: 'neutral', information: 'neutral', default: 'neutral', normal: 'neutral', secondary: 'neutral', muted: 'neutral',
  ok: 'success', good: 'success', positive: 'success', green: 'success', done: 'success', complete: 'success', healthy: 'success',
  caution: 'warning', warn: 'warning', yellow: 'warning', amber: 'warning', pending: 'warning', attention: 'warning',
  error: 'critical', danger: 'critical', destructive: 'critical', red: 'critical', negative: 'critical', urgent: 'critical', overdue: 'critical',
};

export const buttonToneSynonyms: Record<string, string> = {
  primary: 'primary', cta: 'primary', accent: 'primary', recommended: 'primary', submit: 'primary', success: 'primary',
  secondary: 'secondary', default: 'secondary', ghost: 'secondary', neutral: 'secondary', muted: 'secondary', tertiary: 'secondary',
  danger: 'danger', critical: 'danger', destructive: 'danger', error: 'danger', warning: 'danger',
};

export const accentSynonyms: Record<string, string> = {
  purple: 'violet', lavender: 'violet', magenta: 'violet',
  blue: 'sky', cyan: 'sky', azure: 'sky', navy: 'indigo',
  green: 'emerald', mint: 'teal', lime: 'emerald', forest: 'emerald',
  yellow: 'amber', gold: 'amber', orange: 'amber',
  red: 'rose', pink: 'rose', crimson: 'rose', coral: 'rose',
  gray: 'slate', grey: 'slate', silver: 'slate', neutral: 'slate',
};

export const inputTypeSynonyms: Record<string, string> = {
  'e-mail': 'email', mail: 'email', string: 'text', link: 'url', website: 'url',
  phone: 'tel', telephone: 'tel', numeric: 'number', integer: 'number', age: 'number',
  datetime: 'date', 'datetime-local': 'date', birthday: 'date', dob: 'date',
};

export const senderSynonyms: Record<string, string> = {
  me: 'user', you: 'user', self: 'user', customer: 'user', client: 'user', patient: 'user', human: 'user', visitor: 'user', right: 'user', outgoing: 'user',
  assistant: 'other', agent: 'other', support: 'other', bot: 'other', ai: 'other', them: 'other', system: 'other', staff: 'other', left: 'other', incoming: 'other',
};

/** Read-only view of the interpretation layer, rendered in the harness panel. */
export const COERCION_VOCABULARY = {
  components: componentSynonyms,
  semanticTones: semanticToneSynonyms,
  buttonTones: buttonToneSynonyms,
  accents: accentSynonyms,
  inputTypes: inputTypeSynonyms,
} as const;
