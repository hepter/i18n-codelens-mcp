import { includesSearchText, normalizeLimit, previewText } from '../tool-utils';
import { omitEmpty, requireProject, selectLocales, type ToolContext } from './shared';

export type SearchKeysArgs = {
  query?: string;
  keyPrefix?: string;
  searchIn?: 'keys' | 'values' | 'both';
  locales?: string[];
  caseSensitive?: boolean;
  includeValues?: boolean;
  maxValueChars?: number;
  limit?: number;
};

export type SearchMatch = {
  key: string;
  /** Locales holding the key; omitted when every selected locale has it. */
  in?: string[];
  values?: Record<string, string | null>;
};

export type SearchKeysResult = {
  total: number;
  truncated?: boolean;
  locales: string[];
  unknownLocales?: string[];
  matches: SearchMatch[];
};

export async function toolSearchKeys(args: SearchKeysArgs, ctx: ToolContext): Promise<SearchKeysResult> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const keyPrefix = typeof args.keyPrefix === 'string' ? args.keyPrefix.trim() : '';
  if (!query && !keyPrefix) throw new Error('query or keyPrefix is required');
  const searchIn = args.searchIn || 'both';
  const caseSensitive = Boolean(args.caseSensitive);
  const includeValues = Boolean(args.includeValues);
  const maxValueChars = normalizeLimit(args.maxValueChars, 160, 1000);
  const limit = normalizeLimit(args.limit);

  const project = await requireProject(ctx);
  const { locales, unknownLocales } = selectLocales(project, args.locales);

  const matched = new Set<string>();
  for (const locale of locales) {
    for (const [key, value] of project.localeKeys(locale)) {
      if (keyPrefix && !key.startsWith(keyPrefix)) continue;
      if (query) {
        const keyMatches = searchIn !== 'values' && includesSearchText(key, query, caseSensitive);
        const valueMatches = searchIn !== 'keys' && includesSearchText(value, query, caseSensitive);
        if (!keyMatches && !valueMatches) continue;
      }
      matched.add(key);
    }
  }

  const sorted = Array.from(matched).sort((a, b) => a.localeCompare(b));
  const truncated = sorted.length > limit;
  const matches: SearchMatch[] = sorted.slice(0, limit).map(key => {
    const present = locales.filter(locale => project.hasKey(locale, key));
    const match: SearchMatch = { key };
    if (present.length !== locales.length) match.in = present;
    if (includeValues) {
      match.values = {};
      for (const locale of locales) {
        const value = project.getValue(locale, key);
        match.values[locale] = value === undefined ? null : previewText(value, maxValueChars);
      }
    }
    return match;
  });

  return omitEmpty({ total: sorted.length, truncated: truncated || undefined, locales, unknownLocales, matches });
}
