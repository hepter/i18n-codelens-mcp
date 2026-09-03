import { normalizeLocaleTag } from '../core/locale';
import { comparePlaceholders } from '../core/placeholders';
import { createResourceManager } from '../core/resource-manager';
import { omitEmpty, requireProject, type ToolContext } from './shared';
import type { PlaceholderIssue } from './audit';

export type UpsertEntry = { key: string; values: Record<string, string> };

export type UpsertArgs = {
  entries: UpsertEntry[];
  /** Replace values that already differ. Default false: such values are reported as conflicts. */
  overwrite?: boolean;
  /** Default false: changes are written immediately. */
  dryRun?: boolean;
};

export type UpsertResult = {
  applied: boolean;
  dryRun?: boolean;
  files: string[];
  summary: { created: number; updated: number; unchanged: number; conflicts: number };
  created?: Record<string, string[]>;
  updated?: Record<string, Record<string, { before: string; after: string }>>;
  unchanged?: Record<string, string[]>;
  conflicts?: Record<string, Record<string, { current: string; proposed: string }>>;
  warnings?: string[];
  placeholders?: PlaceholderIssue[];
};

type ValidatedEntry = { key: string; values: Array<{ locale: string; value: string }> };

export async function toolUpsertTranslations(args: UpsertArgs, ctx: ToolContext): Promise<UpsertResult> {
  const entries = Array.isArray(args.entries) ? args.entries : [];
  if (!entries.length) throw new Error('entries must contain at least one entry');
  const overwrite = Boolean(args.overwrite);
  const dryRun = args.dryRun === true;

  const project = await requireProject(ctx);
  const manager = createResourceManager(project);

  // Validate everything first so a single bad locale cannot leave the locales half-written.
  const validated: ValidatedEntry[] = entries.map((entry, index) => {
    const key = typeof entry?.key === 'string' ? entry.key.trim() : '';
    if (!key) throw new Error(`entries[${index}]: key is required`);
    project.splitKey(key);
    const rawValues = entry.values && typeof entry.values === 'object' ? entry.values : {};
    const values: ValidatedEntry['values'] = [];
    for (const [rawLocale, rawValue] of Object.entries(rawValues)) {
      if (rawValue === undefined || rawValue === null) continue;
      const locale = normalizeLocaleTag(rawLocale);
      if (!locale || !project.locales.includes(locale)) {
        throw new Error(`entries[${index}] (key '${key}'): unknown locale '${rawLocale}'. Available locales: ${project.locales.join(', ')}.`);
      }
      values.push({ locale, value: String(rawValue) });
    }
    if (!values.length) throw new Error(`entries[${index}] (key '${key}'): values must contain at least one locale`);
    return { key, values };
  });

  const summary = { created: 0, updated: 0, unchanged: 0, conflicts: 0 };
  const created: Record<string, string[]> = {};
  const updated: UpsertResult['updated'] = {};
  const unchanged: Record<string, string[]> = {};
  const conflicts: UpsertResult['conflicts'] = {};
  const warnings: string[] = [];

  for (const { key, values } of validated) {
    for (const { locale, value } of values) {
      const before = manager.get(locale, key);
      if (before === undefined) {
        manager.set(locale, key, value);
        summary.created++;
        (created[key] ??= []).push(locale);
      } else if (before === value) {
        summary.unchanged++;
        (unchanged[key] ??= []).push(locale);
      } else if (overwrite) {
        manager.set(locale, key, value);
        summary.updated++;
        (updated[key] ??= {})[locale] = { before, after: value };
      } else {
        summary.conflicts++;
        (conflicts[key] ??= {})[locale] = { current: before, proposed: value };
      }
    }
    const provided = new Set(values.map(v => v.locale));
    const missingLocales = project.locales.filter(l => !provided.has(l));
    if (missingLocales.length) warnings.push(`${key}: no value for ${missingLocales.join(', ')}`);
  }

  const placeholders: PlaceholderIssue[] = [];
  for (const { key } of validated) {
    const held = project.locales.map(locale => ({ locale, value: manager.get(locale, key) })).filter(v => v.value !== undefined);
    if (held.length < 2) continue;
    const base = held[0];
    for (const other of held.slice(1)) {
      const diff = comparePlaceholders(base.value, other.value);
      if (diff) placeholders.push({ key, locale: other.locale, ...diff });
    }
  }

  const files = manager.commit(dryRun);
  return {
    files,
    ...omitEmpty({
      applied: !dryRun && files.length > 0,
      dryRun: dryRun || undefined,
      summary,
      created,
      updated,
      unchanged,
      conflicts,
      warnings,
      placeholders,
    }),
  } as UpsertResult;
}
