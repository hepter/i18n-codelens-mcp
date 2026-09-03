import { getCodeIndex } from '../core/code-index';
import { loadProject } from '../core/resources';
import { normalizeLimit } from '../tool-utils';
import { cleanKeys, omitEmpty, refText, type ToolContext } from './shared';

export type KeyReferencesArgs = {
  keys: string[];
  /** Max locations per key (default 25, max 100). Totals are always exact. */
  limit?: number;
};

export type KeyReferencesResult = Record<string, { total: number; refs?: string[] }>;

export async function toolKeyReferences(args: KeyReferencesArgs, ctx: ToolContext): Promise<KeyReferencesResult> {
  const keys = cleanKeys(args.keys);
  const limit = normalizeLimit(args.limit, 25, 100);
  const project = await loadProject(ctx.root, ctx.config);
  const index = getCodeIndex(ctx.root, ctx.config);
  await index.refresh({ excludePaths: new Set(project.resources.map(r => r.filePath)) });

  const summaries = index.references(keys, limit);
  const out: KeyReferencesResult = {};
  for (const key of keys) {
    const summary = summaries[key];
    out[key] = omitEmpty({ total: summary.total, refs: summary.references.map(refText) });
  }
  return out;
}
