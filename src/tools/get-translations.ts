import { normalizeLimit, previewText } from '../tool-utils';
import { cleanKeys, expandKeys, isPrefixKey, omitEmpty, requireProject, selectLocales, type ToolContext } from './shared';

export type GetTranslationsArgs = {
  keys: string[];
  locales?: string[];
  /** Default true. False returns only the locales that hold each key. */
  includeValues?: boolean;
  maxValueChars?: number;
  limit?: number;
};

export type TranslationEntry = Record<string, string | null> | string[];

export type GetTranslationsResult = {
  locales: string[];
  unknownLocales?: string[];
  translations: Record<string, TranslationEntry>;
  notFound?: string[];
  total?: number;
  truncated?: boolean;
};

export async function toolGetTranslations(args: GetTranslationsArgs, ctx: ToolContext): Promise<GetTranslationsResult> {
  const requested = cleanKeys(args.keys);
  const includeValues = args.includeValues !== false;
  const maxValueChars = normalizeLimit(args.maxValueChars, 160, 1000);
  const limit = normalizeLimit(args.limit);
  const project = await requireProject(ctx);
  const { locales, unknownLocales } = selectLocales(project, args.locales);

  const literal = new Set(requested.filter(k => !isPrefixKey(project, k)));
  const { keys } = expandKeys(project, requested);
  const total = keys.length;
  const truncated = total > limit;
  const selected = keys.slice(0, limit);

  const translations: Record<string, TranslationEntry> = {};
  const notFound: string[] = [];
  for (const key of selected) {
    const values: Record<string, string | null> = {};
    const present: string[] = [];
    for (const locale of locales) {
      const value = project.getValue(locale, key);
      if (value !== undefined) present.push(locale);
      if (includeValues) values[locale] = value === undefined ? null : previewText(value, maxValueChars);
    }
    if (!present.length && literal.has(key) && !project.locales.some(l => project.hasKey(l, key))) {
      notFound.push(key);
      continue;
    }
    translations[key] = includeValues ? values : present;
  }

  return omitEmpty({
    locales,
    unknownLocales,
    translations,
    notFound,
    total: truncated ? total : undefined,
    truncated: truncated || undefined,
  });
}
