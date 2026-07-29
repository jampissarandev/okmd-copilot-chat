/**
 * Safely parse a JSON string into an object, returning an empty object on failure.
 */
export function parseJsonSafe(json: string): object {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
