import { getEffectiveConfigFromEnv, type EffectiveConfig } from '../config';
import { getWorkspaceRoot, resolveWorkspaceDir, toPosixPath } from '../core/workspace';
import { loadProject, type Project } from '../core/resources';
import { normalizeLocaleTag } from '../core/locale';
import type { CodeReference } from '../core/code-index';
import { uniqueStrings } from '../tool-utils';

export type ToolContext = {
  /** Absolute workspace root every tool call operates on. */
  root: string;
  config: EffectiveConfig;
};

export type ToolContextOptions = {
  /** Explicit root; falls back to CLI/env/cwd resolution. */
  workspaceRoot?: string;
  /** Per-call `workspaceDir` argument; must stay inside the configured root. */
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
};

export function createToolContext(options: ToolContextOptions = {}): ToolContext {
  const env = options.env ?? process.env;
  const config = getEffectiveConfigFromEnv(env);
  const configuredRoot = getWorkspaceRoot(options.workspaceRoot, env);
  const root = resolveWorkspaceDir(options.workspaceDir, { configuredRoot, allowAnyWorkspace: config.allowAnyWorkspace });
  return { root, config };
}

/** Load the project and fail with an actionable message when no locale files matched. */
export async function requireProject(ctx: ToolContext): Promise<Project> {
  const project = await loadProject(ctx.root, ctx.config);
  if (project.resources.length === 0) {
    const skipped = project.warnings.filter(w => w.kind === 'skipped').flatMap(w => w.files);
    const hint = skipped.length
      ? ` ${skipped.length} JSON file(s) matched but were not named like a locale (e.g. ${skipped.slice(0, 3).join(', ')}).`
      : '';
    throw new Error(
      `No i18n resource files found under ${toPosixPath(ctx.root)} with I18N_GLOB='${ctx.config.resourceGlob}'.${hint} ` +
      'Set WORKSPACE_ROOT or I18N_GLOB so the locale JSON files (en.json, tr.json or en/common.json) are matched.'
    );
  }
  return project;
}

export type LocaleSelection = { locales: string[]; unknownLocales: string[] };

/** Normalize requested locales against the project; every locale when none requested. */
export function selectLocales(project: Project, requested?: string[]): LocaleSelection {
  if (!requested || !requested.length) return { locales: [...project.locales], unknownLocales: [] };
  const normalized = uniqueStrings(requested.map(normalizeLocaleTag));
  const locales = normalized.filter(l => project.locales.includes(l));
  const unknownLocales = normalized.filter(l => !project.locales.includes(l));
  if (!locales.length) {
    throw new Error(`None of the requested locales exist (${normalized.join(', ')}). Available locales: ${project.locales.join(', ')}.`);
  }
  return { locales, unknownLocales };
}

/** True when the key names a namespace: `nav.` or `common:`. */
export function isPrefixKey(project: Project, key: string): boolean {
  return key.endsWith('.') || (project.namespaced && key.endsWith(project.nsSeparator));
}

/** Expand trailing-dot / trailing-separator keys to every key under that prefix. */
export function expandKeys(project: Project, keys: string[]): { keys: string[]; expanded: boolean } {
  const out: string[] = [];
  const seen = new Set<string>();
  let expanded = false;
  const all = project.allKeys();
  for (const key of keys) {
    const candidates = isPrefixKey(project, key) ? ((expanded = true), all.filter(k => k.startsWith(key))) : [key];
    for (const candidate of candidates) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      out.push(candidate);
    }
  }
  return { keys: out, expanded };
}

export function cleanKeys(keys: unknown, what = 'keys'): string[] {
  const list = Array.isArray(keys) ? keys.map(k => (typeof k === 'string' ? k.trim() : '')).filter(Boolean) : [];
  if (!list.length) throw new Error(`${what} must contain at least one key`);
  return Array.from(new Set(list));
}

export function refText(ref: CodeReference): string {
  return `${ref.filePath}:${ref.line}:${ref.column}`;
}

/** Drop undefined values and empty arrays/objects so responses stay compact. */
export function omitEmpty<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (Array.isArray(entry) && entry.length === 0) continue;
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && Object.keys(entry as object).length === 0) continue;
    out[key] = entry;
  }
  return out as T;
}
