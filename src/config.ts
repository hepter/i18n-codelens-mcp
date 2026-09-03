export const DEFAULT_RESOURCE_GLOB = '**/locales/**/*.json';
export const DEFAULT_CODE_GLOB = '**/*.{ts,tsx,js,jsx}';
export const DEFAULT_IGNORE_GLOBS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/.cache/**',
];

/**
 * Matches `t("key")`, `T('key')`, `i18n.t("key")`, `{t("key")}` and the
 * `/** @i18n *\/ "key"` marker. The call may sit at the very start of a file.
 * Keys may contain letters, digits, spaces, dots, underscores, hyphens and the
 * namespace colon. Template literals are deliberately excluded.
 */
export const DEFAULT_CODE_REGEX_PATTERN = String.raw`(?<=\/\*\*\s*?@i18n\s*?\*\/\s*?["']|(?:^|\W)[tT]\(\s*["'])(?<key>[A-Za-z0-9 ._:-]+?)(?=["'])`;

export const DEFAULT_NS_SEPARATOR = ':';

export type StructurePreference = 'auto' | 'flat' | 'nested';
export const DEFAULT_STRUCTURE_PREFERENCE: StructurePreference = 'auto';

export type InsertOrderStrategy = 'append' | 'nearby' | 'sort';
export const DEFAULT_INSERT_ORDER_STRATEGY: InsertOrderStrategy = 'nearby';

export function parseRegex(pattern: string): RegExp {
  if (!pattern) return new RegExp(DEFAULT_CODE_REGEX_PATTERN, 'g');
  if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
    const lastSlash = pattern.lastIndexOf('/');
    const body = pattern.substring(1, lastSlash);
    const flags = pattern.substring(lastSlash + 1);
    const finalFlags = flags.includes('g') ? flags : `${flags}g`;
    return new RegExp(body, finalFlags);
  }
  return new RegExp(pattern, 'g');
}

export function buildCodeRegex(pattern?: string): RegExp {
  const source = pattern && pattern.trim().length ? pattern : DEFAULT_CODE_REGEX_PATTERN;
  return parseRegex(source);
}

export type EffectiveConfig = {
  resourceGlob: string;
  codeGlob: string;
  codeRegex: RegExp;
  /** True when I18N_CODE_REGEX overrides the built-in pattern. */
  customCodeRegex: boolean;
  ignoreGlobs: string[];
  structurePreference: StructurePreference;
  insertOrderStrategy: InsertOrderStrategy;
  /** Separator between namespace and key for `{locale}/{namespace}.json` layouts. */
  nsSeparator: string;
  /** Namespace used for keys written without one in a namespaced project. */
  defaultNamespace?: string;
  /** Allow the per-call workspaceDir argument to point outside the configured root. */
  allowAnyWorkspace: boolean;
};

export function parseBooleanFlag(value?: string): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function getEffectiveConfigFromEnv(env: NodeJS.ProcessEnv): EffectiveConfig {
  const customPattern = env.I18N_CODE_REGEX && env.I18N_CODE_REGEX.trim().length ? env.I18N_CODE_REGEX : undefined;
  return {
    resourceGlob: env.I18N_GLOB || DEFAULT_RESOURCE_GLOB,
    codeGlob: env.I18N_CODE_GLOB || DEFAULT_CODE_GLOB,
    codeRegex: buildCodeRegex(customPattern),
    customCodeRegex: Boolean(customPattern),
    ignoreGlobs: parseIgnoreGlobs(env.I18N_IGNORE),
    structurePreference: parseStructurePreference(env.I18N_STRUCTURE),
    insertOrderStrategy: parseInsertOrderStrategy(env.I18N_INSERT_ORDER),
    nsSeparator: env.I18N_NS_SEPARATOR && env.I18N_NS_SEPARATOR.length ? env.I18N_NS_SEPARATOR : DEFAULT_NS_SEPARATOR,
    defaultNamespace: env.I18N_DEFAULT_NS && env.I18N_DEFAULT_NS.trim().length ? env.I18N_DEFAULT_NS.trim() : undefined,
    allowAnyWorkspace: parseBooleanFlag(env.I18N_ALLOW_ANY_WORKSPACE),
  };
}

export function parseIgnoreGlobs(value?: string): string[] {
  if (!value) return [...DEFAULT_IGNORE_GLOBS];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every(v => typeof v === 'string')) return parsed as string[];
  } catch { /* not JSON */ }
  const parts = value.split(/[;,]/).map((s: string) => s.trim()).filter(Boolean);
  return parts.length ? parts : [...DEFAULT_IGNORE_GLOBS];
}

export function parseStructurePreference(value?: string): StructurePreference {
  if (!value) return DEFAULT_STRUCTURE_PREFERENCE;
  const normalized = value.toLowerCase();
  if (normalized === 'flat' || normalized === 'nested' || normalized === 'auto') return normalized;
  return DEFAULT_STRUCTURE_PREFERENCE;
}

export function parseInsertOrderStrategy(value?: string): InsertOrderStrategy {
  if (!value) return DEFAULT_INSERT_ORDER_STRATEGY;
  const normalized = value.toLowerCase();
  if (normalized === 'append' || normalized === 'nearby' || normalized === 'sort') return normalized;
  return DEFAULT_INSERT_ORDER_STRATEGY;
}
