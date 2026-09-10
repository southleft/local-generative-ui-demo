/**
 * The shared React design system: eighteen presentational components and the
 * value sets they can render. The catalog turns these value sets into A2UI
 * schemas, so the design system, not the model, owns every visual decision.
 */

import type { ReactNode } from 'react';

export const pageAccents = ['indigo', 'violet', 'sky', 'teal', 'emerald', 'amber', 'rose', 'slate'] as const;
export const stackGaps = ['sm', 'md', 'lg'] as const;
export const inlineAligns = ['start', 'center', 'end', 'stretch'] as const;
export const inlineJustifies = ['start', 'center', 'end', 'spaceBetween'] as const;
export const gridColumns = [2, 3, 4] as const;
export const cardTones = ['default', 'recommended', 'muted', 'neutral', 'success', 'warning', 'critical'] as const;
export const headingLevels = ['h1', 'h2', 'h3'] as const;
export const textTones = ['default', 'muted', 'neutral', 'success', 'warning', 'critical'] as const;
export const semanticTones = ['neutral', 'success', 'warning', 'critical'] as const;
export const bubbleSenders = ['user', 'other'] as const;
export const inputTypes = ['text', 'email', 'url', 'number', 'date', 'tel'] as const;
export const buttonTones = ['primary', 'secondary', 'danger'] as const;

export type PageAccent = (typeof pageAccents)[number];
export type SemanticTone = (typeof semanticTones)[number];
export type SelectOption = { label: string; value: string };

function Icon({ icon }: { icon?: string }) {
  return icon ? <span className="ds-icon" aria-hidden="true">{icon}</span> : null;
}

export function Page({ children, accent }: { children?: ReactNode; accent?: PageAccent }) {
  return <section className={`ds-page${accent ? ` ds-page--accent-${accent}` : ''}`}>{children}</section>;
}
export function Stack({ children, gap = 'md' }: { children?: ReactNode; gap?: (typeof stackGaps)[number] }) {
  return <div className={`ds-stack ds-stack--${gap}`}>{children}</div>;
}
export function Inline({ children, align = 'start', justify = 'start' }: { children?: ReactNode; align?: (typeof inlineAligns)[number]; justify?: (typeof inlineJustifies)[number] }) {
  return <div className={`ds-inline ds-inline--align-${align} ds-inline--justify-${justify}`}>{children}</div>;
}
export function Grid({ children, columns = 2 }: { children?: ReactNode; columns?: (typeof gridColumns)[number] }) {
  return <div className={`ds-grid ds-grid--${columns}`}>{children}</div>;
}
export function Card({ children, tone = 'default' }: { children?: ReactNode; tone?: (typeof cardTones)[number] }) {
  return <section className={`ds-card ds-card--${tone}`}>{children}</section>;
}
export function Heading({ text, level = 'h2', icon }: { text: string; level?: (typeof headingLevels)[number]; icon?: string }) {
  const Tag = level;
  return <Tag className="ds-heading"><Icon icon={icon} />{text}</Tag>;
}
export function Text({ text, tone = 'default' }: { text: string; tone?: (typeof textTones)[number] }) {
  return <p className={`ds-text ds-text--${tone}`}>{text}</p>;
}
export function ChatBubble({ text, from = 'other', name }: { text: string; from?: (typeof bubbleSenders)[number]; name?: string }) {
  return (
    <div className={`ds-bubble ds-bubble--${from}`}>
      {name ? <span className="ds-bubble__name">{name}</span> : null}
      <p>{text}</p>
    </div>
  );
}
export function Metric({ label, value, detail, tone = 'neutral', icon }: { label: string; value: string; detail?: string; tone?: SemanticTone; icon?: string }) {
  return <div className={`ds-metric ds-metric--${tone}`}><span className="ds-metric__label"><Icon icon={icon} />{label}</span><strong className="ds-metric__value">{value}</strong>{detail ? <span className="ds-metric__trend">{detail}</span> : null}</div>;
}
export function StatusBadge({ label, tone = 'neutral' }: { label: string; tone?: SemanticTone }) {
  return <span className={`ds-status ds-status--${tone}`}><span className="ds-status__dot" aria-hidden="true" />{label}</span>;
}
export function Tag({ label, tone = 'neutral', icon }: { label: string; tone?: SemanticTone; icon?: string }) {
  return <span className={`ds-tag ds-tag--${tone}`}><Icon icon={icon} />{label}</span>;
}
export function ProgressBar({ label, percent, tone }: { label: string; percent: number; tone?: SemanticTone }) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  return (
    <div className={`ds-progress${tone ? ` ds-progress--${tone}` : ''}`}>
      <div className="ds-progress__head"><span>{label}</span><strong>{Math.round(clamped)}%</strong></div>
      <div className="ds-progress__track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped)}><span style={{ width: `${clamped}%` }} /></div>
    </div>
  );
}
export function Alert({ title, message, tone = 'neutral', icon }: { title: string; message: string; tone?: SemanticTone; icon?: string }) {
  return <div className={`ds-alert ds-alert--${tone}`} role="status"><strong><Icon icon={icon} />{title}</strong><p>{message}</p></div>;
}
export function Divider() {
  return <hr className="ds-divider" />;
}

export function TextField({ label, value = '', placeholder, inputType = 'text', onChange }: { label: string; value?: string; placeholder?: string; inputType?: (typeof inputTypes)[number]; onChange?: (value: string) => void }) {
  return <label className="ds-field"><span>{label}</span><input type={inputType} value={value} placeholder={placeholder} onChange={(event) => onChange?.(event.target.value)} /></label>;
}
export function TextArea({ label, value = '', placeholder, onChange }: { label: string; value?: string; placeholder?: string; onChange?: (value: string) => void }) {
  return <label className="ds-field"><span>{label}</span><textarea rows={3} value={value} placeholder={placeholder} onChange={(event) => onChange?.(event.target.value)} /></label>;
}
export function Select({ label, value = '', options = [], onChange }: { label: string; value?: string; options?: SelectOption[]; onChange?: (value: string) => void }) {
  return <label className="ds-field"><span>{label}</span><select value={value} onChange={(event) => onChange?.(event.target.value)}>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
}
export function Button({ label, tone = 'secondary', icon, onPress }: { label: string; tone?: (typeof buttonTones)[number]; icon?: string; onPress?: () => void }) {
  return <button className={`ds-button ds-button--${tone}`} type="button" onClick={onPress}><Icon icon={icon} />{label}</button>;
}
