import { getCodeIndex } from '../core/code-index';
import { normalizeLocaleTag } from '../core/locale';
import { comparePlaceholders } from '../core/placeholders';
import { normalizeLimit } from '../tool-utils';
import { omitEmpty, refText, requireProject, selectLocales, type ToolContext } from './shared';

export type AuditCheck = 'missing' | 'placeholders' | 'code' | 'unused';
export const AUDIT_CHECKS: AuditCheck[] = ['missing', 'placeholders', 'code', 'unused'];

export type AuditArgs = {
  baseLocale?: string;
  locales?: string[];
  checks?: AuditCheck[];
  limit?: number;
  includeReferences?: boolean;
};

export type PlaceholderIssue = { key: string; locale: string; missing: string[]; extra: string[] };
export type CodeMissingEntry = string[] | { missing: string[]; refs: string[] };

export type AuditResult = {
  base: string;
  locales: string[];
  unknownLocales?: string[];
  summary: Partial<Record<'missing' | 'extra' | 'placeholders' | 'code' | 'unused', number>>;
  /** Sections cut by `limit`; the summary still holds full counts. */
  truncated?: string[];
  /** Base-locale keys -> locales lacking them. */
  missing?: Record<string, string[]>;
  /** Locale -> keys it has that the base locale lacks. */
  extra?: Record<string, string[]>;
  placeholders?: PlaceholderIssue[];
  /** Keys referenced in code -> locales lacking them (with refs when requested). */
  code?: Record<string, CodeMissingEntry>;
  /** Keys present in locale files but never referenced in code. */
  unused?: string[];
  warnings?: string[];
};

export async function toolAudit(args: AuditArgs, ctx: ToolContext): Promise<AuditResult> {
  const project = await requireProject(ctx);
  const { locales, unknownLocales } = selectLocales(project, args.locales);
  const base = normalizeLocaleTag(args.baseLocale || locales[0]);
  if (!project.locales.includes(base)) {
    throw new Error(`Base locale '${base}' not found. Available locales: ${project.locales.join(', ')}.`);
  }
  if (!locales.includes(base)) locales.unshift(base);
  const checks = new Set<AuditCheck>(args.checks && args.checks.length ? args.checks : AUDIT_CHECKS);
  const limit = normalizeLimit(args.limit);
  const others = locales.filter(l => l !== base);
  const baseKeys = project.localeKeys(base);

  const summary: AuditResult['summary'] = {};
  const truncated: string[] = [];
  const cut = <T>(name: string, items: T[]): T[] => {
    if (items.length > limit) truncated.push(name);
    return items.slice(0, limit);
  };
  const result: AuditResult = { base, locales, summary };

  if (checks.has('missing')) {
    const missing: Array<[string, string[]]> = [];
    for (const key of baseKeys.keys()) {
      const lacking = others.filter(locale => !project.hasKey(locale, key));
      if (lacking.length) missing.push([key, lacking]);
    }
    const extra: Record<string, string[]> = {};
    let extraTotal = 0;
    for (const locale of others) {
      const keys = Array.from(project.localeKeys(locale).keys()).filter(key => !baseKeys.has(key));
      if (keys.length) {
        extraTotal += keys.length;
        extra[locale] = cut('extra', keys);
      }
    }
    summary.missing = missing.length;
    summary.extra = extraTotal;
    result.missing = Object.fromEntries(cut('missing', missing));
    result.extra = extra;
  }

  if (checks.has('placeholders')) {
    const issues: PlaceholderIssue[] = [];
    for (const [key, baseValue] of baseKeys) {
      for (const locale of others) {
        const value = project.getValue(locale, key);
        if (value === undefined) continue;
        const diff = comparePlaceholders(baseValue, value);
        if (diff) issues.push({ key, locale, ...diff });
      }
    }
    summary.placeholders = issues.length;
    result.placeholders = cut('placeholders', issues);
  }

  if (checks.has('code') || checks.has('unused')) {
    const index = getCodeIndex(ctx.root, ctx.config);
    await index.refresh({ excludePaths: new Set(project.resources.map(r => r.filePath)) });
    const codeKeys = index.allKeys();

    if (checks.has('code')) {
      const missing: Array<[string, string[]]> = [];
      for (const key of Array.from(codeKeys).sort((a, b) => a.localeCompare(b))) {
        const lacking = locales.filter(locale => !project.hasKey(locale, key));
        if (lacking.length) missing.push([key, lacking]);
      }
      summary.code = missing.length;
      const shown = cut('code', missing);
      if (args.includeReferences && shown.length) {
        const refs = index.references(shown.map(([key]) => key), 5);
        result.code = Object.fromEntries(shown.map(([key, lacking]) => [key, { missing: lacking, refs: refs[key].references.map(refText) }]));
      } else {
        result.code = Object.fromEntries(shown);
      }
    }

    if (checks.has('unused')) {
      const unused = new Set<string>();
      for (const locale of locales) {
        for (const key of project.localeKeys(locale).keys()) if (!codeKeys.has(key)) unused.add(key);
      }
      const sorted = Array.from(unused).sort((a, b) => a.localeCompare(b));
      summary.unused = sorted.length;
      result.unused = cut('unused', sorted);
    }
  }

  return omitEmpty({
    ...result,
    unknownLocales,
    truncated: Array.from(new Set(truncated)),
    warnings: project.warnings.map(w => w.message),
  });
}
