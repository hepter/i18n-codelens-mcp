const PLACEHOLDER_BRACE = /\{\{\s*([\w.-]+)\s*\}\}/g;
const PLACEHOLDER_CURVY = /\{\s*([\w.-]+)\s*\}/g;

/** Placeholder names in a translation value: `{{name}}`, `{count}`, `{0}`. */
export function extractPlaceholders(value: string | undefined | null): Set<string> {
  const placeholders = new Set<string>();
  if (!value) return placeholders;
  for (const regex of [PLACEHOLDER_BRACE, PLACEHOLDER_CURVY]) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(value)) !== null) {
      if (match[1]) placeholders.add(match[1]);
    }
  }
  return placeholders;
}

export type PlaceholderDiff = { missing: string[]; extra: string[] };

/** Placeholders of `base` absent from `other`, and vice versa. Undefined when they agree. */
export function comparePlaceholders(base: string | undefined | null, other: string | undefined | null): PlaceholderDiff | undefined {
  const basePlaceholders = extractPlaceholders(base);
  const otherPlaceholders = extractPlaceholders(other);
  const missing = Array.from(basePlaceholders).filter(ph => !otherPlaceholders.has(ph));
  const extra = Array.from(otherPlaceholders).filter(ph => !basePlaceholders.has(ph));
  if (!missing.length && !extra.length) return undefined;
  return { missing, extra };
}
