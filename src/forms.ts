/**
 * Helpers for urlencoded form bodies, shared by the HTML controllers.
 * `src/api/` parses JSON and does not need these.
 */

/**
 * Express yields a string for a field sent once and an array when it repeats, so a
 * checkbox group is either shape depending on how many boxes the user ticked.
 */
export function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return value === undefined ? [] : [String(value)];
}
