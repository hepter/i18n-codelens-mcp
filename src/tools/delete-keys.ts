import { createResourceManager } from '../core/resource-manager';
import { cleanKeys, omitEmpty, requireProject, selectLocales, type ToolContext } from './shared';

export type DeleteKeysArgs = {
  keys: string[];
  locales?: string[];
  /** Default true: preview only. Pass false to delete. */
  dryRun?: boolean;
};

export type DeleteKeysResult = {
  applied: boolean;
  dryRun?: boolean;
  files: string[];
  /** Key -> locales it was (or would be) removed from. */
  deleted?: Record<string, string[]>;
  notFound?: string[];
  unknownLocales?: string[];
};

export async function toolDeleteKeys(args: DeleteKeysArgs, ctx: ToolContext): Promise<DeleteKeysResult> {
  const keys = cleanKeys(args.keys);
  const dryRun = args.dryRun !== false;
  const project = await requireProject(ctx);
  const { locales, unknownLocales } = selectLocales(project, args.locales);
  const manager = createResourceManager(project);

  const deleted: Record<string, string[]> = {};
  const notFound: string[] = [];
  for (const key of keys) {
    for (const locale of locales) {
      if (manager.get(locale, key) === undefined) continue;
      if (manager.delete(locale, key)) (deleted[key] ??= []).push(locale);
    }
    if (!deleted[key]) notFound.push(key);
  }

  const files = manager.commit(dryRun);
  return {
    files,
    ...omitEmpty({ applied: !dryRun && files.length > 0, dryRun: dryRun || undefined, deleted, notFound, unknownLocales }),
  } as DeleteKeysResult;
}
