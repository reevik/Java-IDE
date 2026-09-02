/**
 * Best-effort parse of a JSON object that is still being streamed.
 *
 * The model emits one object progressively, so at any moment we hold a prefix
 * like `{"quality":{"score":78},"summary":"Clear but`. This walks the prefix,
 * discards a trailing half-written token, then closes any open string/array/
 * object so the result is valid JSON. Keys that have fully arrived survive;
 * anything still in flight is simply absent.
 *
 * Returns null when nothing usable has arrived yet.
 */
export function parsePartialJson<T = unknown>(raw: string): Partial<T> | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  const s = raw.slice(start);

  // Fast path: it's already complete and valid.
  try {
    return JSON.parse(s) as Partial<T>;
  } catch {
    /* still streaming — repair below */
  }

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  // Positions we may safely truncate at: the end of a completed element. Note a
  // closing quote is NOT one — it may belong to a *key*, and cutting there would
  // leave `{"a":1,"b"` (a dangling key) which never parses.
  const boundaries: number[] = [];

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }

    if (c === '"') {
      inString = true;
    } else if (c === "{" || c === "[") {
      stack.push(c === "{" ? "}" : "]");
    } else if (c === "}" || c === "]") {
      stack.pop();
      boundaries.push(i + 1);
    } else if (c === ",") {
      boundaries.push(i); // cut *before* the comma; what follows is incomplete
    }
  }

  const attempt = (candidate: string): Partial<T> | null => {
    try {
      return JSON.parse(candidate) as Partial<T>;
    } catch {
      return null;
    }
  };

  // 1) Close the string we're inside, then all open containers.
  if (inString) {
    const r = attempt(s + '"' + closers(stack));
    if (r) return r;
  }
  // 2) We're between tokens — just close the open containers.
  const asIs = attempt(s + closers(stack));
  if (asIs) return asIs;

  // 3) Walk back through element boundaries, dropping the trailing partial
  //    element until something parses. Bounded so a huge buffer can't stall.
  for (let i = boundaries.length - 1, tries = 0; i >= 0 && tries < 60; i--, tries++) {
    const cut = s.slice(0, boundaries[i]);
    const r = attempt(cut + closersFor(cut));
    if (r) return r;
  }
  return null;
}

function closers(stack: string[]): string {
  return stack.slice().reverse().join("");
}

/** Recompute the open containers for an arbitrary prefix. */
function closersFor(s: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const c of s) {
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") stack.pop();
  }
  return (inString ? '"' : "") + closers(stack);
}
