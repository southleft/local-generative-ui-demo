/**
 * Prompt sparks: the example requests offered as chips under the request box.
 * The first one is the request the page opens with.
 */
export interface Spark {
  label: string;
  prompt: string;
}

export const SPARKS: Spark[] = [
  { label: '🩺 Boring med form', prompt: 'A patient intake form for a family clinic: full name, date of birth, phone, email, reason for visit, current medications, and known allergies, with a submit action. Deliberately plain and professional.' },
  { label: '💬 Support chat', prompt: 'A customer support chat about a delayed order: a short back-and-forth conversation between the customer and the support agent, ending with a proposed solution, plus a reply box and send button.' },
  { label: '📦 Project status', prompt: 'A status dashboard for a website redesign project: overall progress, budget used, open tasks, a blockers alert, and actions to view the board or export a report.' },
  { label: '⚙️ Account settings', prompt: 'An account settings page: profile details, notification preferences, and a clearly separated danger zone with a delete-account action.' },
  { label: '🧾 Checkout review', prompt: 'A checkout review screen for a small web shop: a summary of the ordered items, shipping details fields, the order total, and a place-order action.' },
  { label: '🍞 Sourdough control', prompt: 'Mission control for my sourdough starter: fermentation progress, feeding schedule, rise metrics, and an emergency deflation alert.' },
];

export const DEFAULT_PROMPT = SPARKS[0].prompt;
