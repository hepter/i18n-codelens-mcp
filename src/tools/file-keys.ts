import fs from 'fs';
import path from 'path';
import { keysInFile } from '../core/code-index';
import { ensureSafeWorkspacePath, relativeToWorkspace } from '../core/workspace';
import { omitEmpty, requireProject, type ToolContext } from './shared';

export type FileKeysArgs = {
  filePath: string;
  /** Default false: report only the count of fully translated keys. */
  includeComplete?: boolean;
};

export type FileKeysResult = {
  file: string;
  total: number;
  /** Key -> locales that lack it. */
  missing?: Record<string, string[]>;
  complete: number | string[];
};

export async function toolFileKeys(args: FileKeysArgs, ctx: ToolContext): Promise<FileKeysResult> {
  const requested = typeof args.filePath === 'string' ? args.filePath.trim() : '';
  if (!requested) throw new Error('filePath is required');
  const absolute = path.isAbsolute(requested) ? requested : path.join(ctx.root, requested);
  const safe = ensureSafeWorkspacePath(absolute, ctx.root);
  if (!fs.existsSync(safe) || !fs.statSync(safe).isFile()) {
    throw new Error(`File not found: ${relativeToWorkspace(safe, ctx.root)}`);
  }
  const project = await requireProject(ctx);
  const keys = keysInFile(safe, ctx.config.codeRegex);

  const missing: Record<string, string[]> = {};
  const complete: string[] = [];
  for (const key of keys) {
    const lacking = project.locales.filter(locale => !project.hasKey(locale, key));
    if (lacking.length) missing[key] = lacking;
    else complete.push(key);
  }

  return omitEmpty({
    file: relativeToWorkspace(safe, ctx.root),
    total: keys.length,
    missing,
    complete: args.includeComplete ? complete : complete.length,
  });
}
