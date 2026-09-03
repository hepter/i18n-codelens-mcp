export const DEFAULT_RESULT_LIMIT = 50;
export const MAX_RESULT_LIMIT = 500;
export const DEFAULT_PREVIEW_CHARS = 160;

export type LimitedResult<T> = {
  total: number;
  limit: number;
  truncated: boolean;
  items: T[];
};

export function normalizeLimit(value: unknown, fallback = DEFAULT_RESULT_LIMIT, max = MAX_RESULT_LIMIT): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(raw, 1), max);
}

export function limitItems<T>(items: T[], limit: number): LimitedResult<T> {
  const safeLimit = normalizeLimit(limit);
  return {
    total: items.length,
    limit: safeLimit,
    truncated: items.length > safeLimit,
    items: items.slice(0, safeLimit),
  };
}

export function previewText(value: unknown, maxChars = DEFAULT_PREVIEW_CHARS): string {
  const text = typeof value === 'undefined' || value === null ? '' : String(value);
  const limit = normalizeLimit(maxChars, DEFAULT_PREVIEW_CHARS, 1000);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(limit - 1, 1))}…`;
}

export function shouldDryRun(value: unknown): boolean {
  return value !== false;
}

export function uniqueStrings(values: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(values).map(v => v.trim()).filter(Boolean)));
}

export function includesSearchText(value: string, query: string, caseSensitive = false): boolean {
  if (!query) return true;
  if (caseSensitive) return value.includes(query);
  return value.toLowerCase().includes(query.toLowerCase());
}
