/**
 * Text-level repair of model output into a JSON value. Everything here works
 * on the raw string and knows nothing about the catalog: it closes what the
 * model left open, splits what it fused, and re-splits what it ran together.
 * Each intervention is reported so the run's adjustment count stays honest.
 */

import { jsonrepair } from 'jsonrepair';
import { isRecord } from './catalog';

export interface RepairedJson {
  value: unknown;
  warnings: string[];
}

/** Drop closing brackets that have no matching opener, outside of string literals. */
export function removeMismatchedClosingDelimiters(input: string): string {
  const stack: string[] = [];
  let output = '';
  let quoted = false;
  let escaped = false;
  for (const character of input) {
    if (escaped) {
      output += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quoted) {
      output += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      output += character;
      continue;
    }
    if (!quoted && (character === '{' || character === '[')) stack.push(character);
    if (!quoted && (character === '}' || character === ']')) {
      if (stack.at(-1) !== (character === '}' ? '{' : '[')) continue;
      stack.pop();
    }
    output += character;
  }
  return output;
}

/**
 * Gemma sometimes fuses a key and its value into one string in key position:
 * {"label":"Watering Frequency","value:12","tone:warning"}. jsonrepair cannot
 * guess a colon there ("Colon expected"), so split the string back into a
 * key/value pair. Only identifier-like keys directly after "{" or "," qualify,
 * which leaves real string values such as "Subtotal: $110.00" untouched.
 */
export function splitFusedKeyValueStrings(input: string): string {
  return input.replace(/(?<=[{,]\s*)"([A-Za-z_][A-Za-z0-9_]*):([^"]*)"(?=\s*[,}\]])/g, '"$1":"$2"');
}

/**
 * When a model truncates the closing braces of its last node, jsonrepair can
 * split the stream into an envelope ({root, components:[...]}) followed by the
 * remaining nodes as separate top-level values. Merge those fragments back
 * into one composition object.
 */
export function mergeParsedFragments(parsed: unknown): unknown {
  if (!Array.isArray(parsed)) return parsed;
  const merged: { root?: unknown; nodes: unknown[] } = { nodes: [] };
  for (const element of parsed) {
    if (!isRecord(element)) continue;
    if (Array.isArray(element.nodes)) {
      merged.root ??= element.root;
      merged.nodes.push(...element.nodes);
    } else if (element.component !== undefined || element.id !== undefined) {
      merged.nodes.push(element);
    }
  }
  return merged.nodes.length ? merged : parsed;
}

/**
 * Some emissions never close a single node object: the entire stream parses as
 * one object whose repeated "id" keys overwrite each other, silently losing
 * almost every node. Detect the mismatch between how many "id" keys the text
 * contains and how many nodes actually parsed, then re-parse by splitting the
 * text at each "id" boundary and repairing every fragment into its own node.
 */
export function explodeRunOnNodeStream(candidate: string, parsedNodeCount: number): { root?: unknown; nodes: unknown[] } | undefined {
  const idCount = (candidate.match(/"id"\s*:/g) ?? []).length;
  if (idCount < 3 || parsedNodeCount >= idCount * 0.6) return undefined;
  const segments = candidate.split(/(?="id"\s*:)/g);
  if (segments.length < 3) return undefined;
  const repair = (text: string): unknown => JSON.parse(jsonrepair(removeMismatchedClosingDelimiters(`{${text}`)));
  const nodes: unknown[] = [];
  for (const segment of segments.slice(1)) {
    try {
      // A fragment that closed its own object ends in ",{" or "," — trim so
      // jsonrepair does not wrap it into an array with an empty trailing object.
      const trimmed = segment.replace(/[\s,{[]+$/, '');
      let parsed: unknown;
      try {
        parsed = repair(trimmed);
      } catch {
        // A quote directly after "}" or "]" is never valid JSON; the model
        // leaves one behind when it closes an inlined child ("...{}}\"}").
        // Only fragments that already failed repair get this second pass.
        parsed = repair(trimmed.replace(/([}\]])\s*"(?=\s*[}\],])/g, '$1'));
      }
      const record = Array.isArray(parsed) ? parsed.find(isRecord) : parsed;
      if (isRecord(record) && typeof record.id === 'string') nodes.push(record);
    } catch {
      // Fragments that cannot be repaired are skipped; salvage handles the rest.
    }
  }
  if (nodes.length <= parsedNodeCount) return undefined;
  const rootMatch = segments[0].match(/"root"\s*:\s*"([^"]+)"/);
  return { ...(rootMatch ? { root: rootMatch[1] } : {}), nodes };
}

/** Deep-count objects carrying an id, so nested-children forms are not mistaken for run-on losses. */
function countParsedNodes(parsed: unknown): number {
  if (Array.isArray(parsed)) return parsed.reduce<number>((count, item) => count + countParsedNodes(item), 0);
  if (!isRecord(parsed)) return 0;
  const own = typeof parsed.id === 'string' || typeof parsed.id === 'number' ? 1 : 0;
  return own + Object.values(parsed).reduce<number>((count, child) => count + countParsedNodes(child), 0);
}

/**
 * Repair raw model output into one JSON value. Markdown fences and leading
 * prose are presentation, not semantics, and are stripped; the rest goes
 * through fused-key splitting, delimiter balancing, jsonrepair, fragment
 * merging, and run-on re-splitting. Throws when nothing parseable survives.
 */
export function repairModelJson(output: string): RepairedJson {
  const cleaned = output.trim().replace(/^[^{[]*?```(?:json)?\s*/i, '').replace(/\s*```[\s\S]*$/, '').trim();
  const sliced = cleaned.startsWith('{') || cleaned.startsWith('[') ? cleaned : cleaned.slice(Math.max(0, cleaned.indexOf('{')));
  if (!sliced) throw new Error('The model returned an empty catalog composition.');
  const candidate = splitFusedKeyValueStrings(sliced);
  const warnings: string[] = [];
  if (candidate !== sliced) warnings.push('Split fused "key:value" strings back into key/value pairs before JSON repair.');
  try {
    const value = mergeParsedFragments(JSON.parse(jsonrepair(removeMismatchedClosingDelimiters(candidate))));
    const kept = countParsedNodes(value);
    const exploded = explodeRunOnNodeStream(candidate, kept);
    if (!exploded) return { value, warnings };
    warnings.push(`Re-split a run-on emission at each "id" boundary: ${exploded.nodes.length} nodes recovered where whole-document parsing kept ${kept}.`);
    return { value: exploded, warnings };
  } catch (error) {
    // Whole-document repair gives up on deeply inlined children, but the
    // stream still has clean "id" boundaries; repair each node on its own and
    // let salvage reattach what survives.
    const reason = error instanceof Error ? error.message : 'Unknown parse error';
    const exploded = explodeRunOnNodeStream(candidate, 0);
    if (!exploded) throw new Error(`The model output was not repairable JSON.\n${reason}`);
    warnings.push(`Whole-document JSON repair failed (${reason.split('\n')[0]}); re-split the output at each "id" boundary and repaired ${exploded.nodes.length} nodes individually.`);
    return { value: exploded, warnings };
  }
}
