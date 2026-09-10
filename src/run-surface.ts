/**
 * Lazy materialization of a run into an official A2UI surface. History keeps
 * transport data (a composition or fixture messages), never live handles, so
 * only the active run is ever compiled.
 */

import { compileToA2ui, processA2uiMessages, type A2uiActionEvent, type A2uiMessage } from './a2ui-protocol';
import type { CompiledRunSurface, GenerationRun } from './generation-types';

export function messageKinds(messages: A2uiMessage[]): string[] {
  return messages.map((message) => Object.keys(message).filter((key) => key !== 'version')[0] ?? 'unknown');
}

export function rawOutputForMessages(messages: A2uiMessage[]): string {
  return messages.map((message) => JSON.stringify(message)).join('\n');
}

export function messagesForRun(run: GenerationRun): A2uiMessage[] | null {
  if (run.a2uiMessages) return run.a2uiMessages;
  return run.composition ? compileToA2ui(run.composition) : null;
}

/** Fail fast if the official processor rejects a message stream; the surface itself is built lazily later. */
export function validateA2uiMessages(messages: A2uiMessage[]): void {
  processA2uiMessages(messages);
}

export function compileRunSurface(run: GenerationRun, onAction: (event: A2uiActionEvent) => void): CompiledRunSurface | null {
  const messages = messagesForRun(run);
  if (!messages) return null;
  return { ...processA2uiMessages(messages, onAction), runId: run.id, messageCount: messages.length, messageKinds: messageKinds(messages) };
}
