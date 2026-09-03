import fs from 'fs';
import { loadJson, writeFilePretty } from '../core/fs-write';
import { classifyResourceStructure, flattenObject, reorderTopLevel, unflattenObject, type FlatResourceMap } from '../resource-utils';
import { omitEmpty, requireProject, selectLocales, type ToolContext } from './shared';

export type FormatResourcesArgs = {
  locales?: string[];
  /** Default true. */
  sortKeys?: boolean;
  /** Default true: preview only. Pass false to write. */
  dryRun?: boolean;
};

export type FormatResourcesResult = {
  applied: boolean;
  dryRun?: boolean;
  /** Files that changed (or would change). */
  files: string[];
  unchanged: number;
  errors?: Record<string, string>;
  unknownLocales?: string[];
};

export async function toolFormatResources(args: FormatResourcesArgs, ctx: ToolContext): Promise<FormatResourcesResult> {
  const dryRun = args.dryRun !== false;
  const sortKeys = args.sortKeys !== false;
  const project = await requireProject(ctx);
  const { locales, unknownLocales } = selectLocales(project, args.locales);

  const files: string[] = [];
  const errors: Record<string, string> = {};
  let unchanged = 0;

  for (const resource of project.resources) {
    if (!locales.includes(resource.locale)) continue;
    try {
      const raw = fs.readFileSync(resource.filePath, 'utf8');
      const json = loadJson(resource.filePath, ctx.root) as Record<string, unknown>;
      let next: Record<string, unknown> = json;
      if (sortKeys) {
        const structure = classifyResourceStructure(json);
        if (structure.kind === 'mixed') {
          // Sort the top level only: restructuring a mixed file would merge a leaf and a namespace of the same name.
          next = reorderTopLevel(json, Object.keys(json).sort((a, b) => a.localeCompare(b)));
        } else {
          const flat = flattenObject(json);
          const ordered: FlatResourceMap = {};
          for (const key of Object.keys(flat).sort((a, b) => a.localeCompare(b))) ordered[key] = flat[key];
          next = structure.kind === 'nested' ? unflattenObject(ordered) : ordered;
        }
      }
      const nextRaw = JSON.stringify(next, null, 2) + '\n';
      if (raw === nextRaw) {
        unchanged++;
        continue;
      }
      files.push(resource.relativePath);
      if (!dryRun) writeFilePretty(resource.filePath, next, ctx.root);
    } catch (error) {
      errors[resource.relativePath] = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    files,
    unchanged,
    ...omitEmpty({ applied: !dryRun && files.length > 0, dryRun: dryRun || undefined, errors, unknownLocales }),
  } as FormatResourcesResult;
}
