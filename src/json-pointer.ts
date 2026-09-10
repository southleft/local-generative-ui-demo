/**
 * RFC 6901 JSON Pointer helpers for the surface data model.
 *
 * Bindings the model writes ("/form/email") become keys of a plain object, so
 * any segment that could reach prototype internals is rejected outright.
 */

const POINTER_LIMIT = 200;
const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/** Split a pointer into decoded segments, throwing on anything unsafe. */
export function decodeJsonPointer(pointer: string): string[] {
  if (!pointer.startsWith('/') || pointer.length > POINTER_LIMIT) throw new Error(`Unsafe JSON Pointer "${pointer}".`);
  const segments = pointer.split('/').slice(1).map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (segments.some((segment) => UNSAFE_SEGMENTS.has(segment))) throw new Error(`Unsafe JSON Pointer "${pointer}".`);
  return segments;
}

export function isSafeJsonPointer(pointer: string): boolean {
  try {
    decodeJsonPointer(pointer);
    return true;
  } catch {
    return false;
  }
}
