import { createResourceManager } from '../core/resource-manager';
import { omitEmpty, requireProject, selectLocales, type ToolContext } from './shared';

export type RenameKeyArgs = {
  /** A key, or a namespace prefix ending with a dot (`nav.`) to move every key under it. */
  from: string;
  to: string;
  locales?: string[];
  /** Default true: preview only. Pass false to write. */
  dryRun?: boolean;
};

export type RenameKeyResult = {
  applied: boolean;
  dryRun?: boolean;
  files: string[];
  /** Old key -> new key (capped at 100 entries for namespace moves). */
  renamed: Record<string, string>;
  /** Number of keys moved by a namespace move. */
  moved?: number;
  /** Locales where the rename happened. */
  locales: string[];
  /** Locales that did not hold the source key. */
  skipped?: string[];
  unknownLocales?: string[];
};

const RENAMED_CAP = 100;

export async function toolRenameKey(args: RenameKeyArgs, ctx: ToolContext): Promise<RenameKeyResult> {
  const from = typeof args.from === 'string' ? args.from.trim() : '';
  let to = typeof args.to === 'string' ? args.to.trim() : '';
  if (!from || !to) throw new Error('from and to are required');
  if (from === to) throw new Error('from and to must differ');
  const dryRun = args.dryRun !== false;
  const namespaceMove = from.endsWith('.');
  if (namespaceMove && !to.endsWith('.')) to = `${to}.`;

  const project = await requireProject(ctx);
  const { locales, unknownLocales } = selectLocales(project, args.locales);
  const manager = createResourceManager(project);

  const plan = new Map<string, Array<{ from: string; to: string; value: string }>>();
  const conflicts = new Map<string, string[]>();
  for (const locale of locales) {
    const moves: Array<{ from: string; to: string; value: string }> = [];
    const sourceKeys = namespaceMove ? manager.listKeys(locale).filter(k => k.startsWith(from)) : [from];
    for (const sourceKey of sourceKeys) {
      const value = manager.get(locale, sourceKey);
      if (value === undefined) continue;
      const targetKey = namespaceMove ? `${to}${sourceKey.slice(from.length)}` : to;
      if (manager.get(locale, targetKey) !== undefined) (conflicts.get(targetKey) ?? conflicts.set(targetKey, []).get(targetKey)!).push(locale);
      moves.push({ from: sourceKey, to: targetKey, value });
    }
    if (moves.length) plan.set(locale, moves);
  }

  if (conflicts.size) {
    const [targetKey, where] = conflicts.entries().next().value as [string, string[]];
    const more = conflicts.size > 1 ? ` (and ${conflicts.size - 1} more)` : '';
    throw new Error(`Target key '${targetKey}' already exists in ${where.join(', ')}${more}. Nothing was changed.`);
  }
  if (!plan.size) {
    throw new Error(`${namespaceMove ? 'Namespace' : 'Key'} '${from}' not found in ${locales.join(', ')}.`);
  }

  const renamed: Record<string, string> = {};
  let moved = 0;
  for (const [locale, moves] of plan) {
    for (const move of moves) {
      manager.delete(locale, move.from);
      manager.set(locale, move.to, move.value);
      moved++;
      if (Object.keys(renamed).length < RENAMED_CAP) renamed[move.from] = move.to;
    }
  }

  const files = manager.commit(dryRun);
  const renamedLocales = Array.from(plan.keys());
  return {
    files,
    renamed,
    locales: renamedLocales,
    ...omitEmpty({
      applied: !dryRun && files.length > 0,
      dryRun: dryRun || undefined,
      moved: namespaceMove ? moved / renamedLocales.length : undefined,
      skipped: locales.filter(l => !plan.has(l)),
      unknownLocales,
    }),
  } as RenameKeyResult;
}
