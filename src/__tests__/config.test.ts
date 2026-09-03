import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RESOURCE_GLOB,
  DEFAULT_CODE_GLOB,
  DEFAULT_IGNORE_GLOBS,
  DEFAULT_CODE_REGEX_PATTERN,
  DEFAULT_STRUCTURE_PREFERENCE,
  DEFAULT_INSERT_ORDER_STRATEGY,
  DEFAULT_NS_SEPARATOR,
  parseRegex,
  buildCodeRegex,
  parseIgnoreGlobs,
  parseStructurePreference,
  parseInsertOrderStrategy,
  parseBooleanFlag,
  getEffectiveConfigFromEnv,
} from '../config';

const matchAll = (regex: RegExp, text: string): string[] => {
  const out: string[] = [];
  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) out.push(m.groups?.key ?? m[0]);
  return out;
};

describe('defaults', () => {
  it('DEFAULT_RESOURCE_GLOB should include locales and json', () => {
    expect(DEFAULT_RESOURCE_GLOB).toContain('locales');
    expect(DEFAULT_RESOURCE_GLOB).toContain('.json');
  });

  it('DEFAULT_CODE_GLOB covers ts/tsx/js/jsx', () => {
    for (const ext of ['ts', 'tsx', 'js', 'jsx']) expect(DEFAULT_CODE_GLOB).toContain(ext);
  });

  it('DEFAULT_IGNORE_GLOBS skips node_modules and common build output', () => {
    expect(DEFAULT_IGNORE_GLOBS).toContain('**/node_modules/**');
    expect(DEFAULT_IGNORE_GLOBS).toContain('**/dist/**');
    expect(DEFAULT_IGNORE_GLOBS).toContain('**/build/**');
    expect(DEFAULT_IGNORE_GLOBS).toContain('**/.git/**');
  });

  it('DEFAULT_CODE_REGEX_PATTERN is non-empty string', () => {
    expect(typeof DEFAULT_CODE_REGEX_PATTERN).toBe('string');
    expect(DEFAULT_CODE_REGEX_PATTERN.length).toBeGreaterThan(0);
  });

  it('DEFAULT_STRUCTURE_PREFERENCE is auto', () => {
    expect(DEFAULT_STRUCTURE_PREFERENCE).toBe('auto');
  });

  it('DEFAULT_INSERT_ORDER_STRATEGY is nearby', () => {
    expect(DEFAULT_INSERT_ORDER_STRATEGY).toBe('nearby');
  });

  it('DEFAULT_NS_SEPARATOR is the i18next colon', () => {
    expect(DEFAULT_NS_SEPARATOR).toBe(':');
  });
});

describe('default code regex', () => {
  const rx = () => buildCodeRegex(undefined);

  it('matches t("key") and T("key") with dotted keys', () => {
    expect(matchAll(rx(), 'const a = t("nav.home"); const b = T(\'btn.save\');')).toEqual(['nav.home', 'btn.save']);
  });

  it('matches member access and JSX braces', () => {
    expect(matchAll(rx(), 'i18n.t("a.b") {t("c.d")}')).toEqual(['a.b', 'c.d']);
  });

  it('matches the /** @i18n */ marker', () => {
    expect(matchAll(rx(), 'const k = /** @i18n */ "marker.key";')).toEqual(['marker.key']);
  });

  it('accepts namespaced keys with a colon', () => {
    expect(matchAll(rx(), 't("common:nav.home")')).toEqual(['common:nav.home']);
  });

  it('accepts hyphens, underscores, digits and spaces', () => {
    expect(matchAll(rx(), 't("a-b_c 1")')).toEqual(['a-b_c 1']);
  });

  it('does not accept angle brackets, which the old character range let through', () => {
    expect(matchAll(rx(), 'x = t("a<b"); y = t("a>b"); z = t("a@b")')).toEqual([]);
  });

  it('matches a call at the very start of the file', () => {
    expect(matchAll(rx(), 't("first.key")')).toEqual(['first.key']);
  });

  it('ignores template literals and identifiers that merely end in t', () => {
    expect(matchAll(rx(), 't(`dyn.${x}`); format("x.y"); split("a.b")')).toEqual([]);
  });
});

describe('parseRegex', () => {
  it('empty string → default regex with g flag', () => {
    const r = parseRegex('');
    expect(r.flags).toContain('g');
    expect(r.source).toBe(DEFAULT_CODE_REGEX_PATTERN);
  });

  it('plain pattern → RegExp with g flag', () => {
    const r = parseRegex('foo');
    expect(r.source).toBe('foo');
    expect(r.flags).toContain('g');
  });

  it('/pattern/i syntax → preserves flags and adds g', () => {
    const r = parseRegex('/abc/i');
    expect(r.source).toBe('abc');
    expect(r.flags).toContain('i');
    expect(r.flags).toContain('g');
  });

  it('/pattern/gi syntax → no duplicate g', () => {
    const r = parseRegex('/abc/gi');
    expect(r.flags.split('g').length - 1).toBe(1);
  });

  it('throws on invalid regex', () => {
    expect(() => parseRegex('[')).toThrow();
  });
});

describe('parseIgnoreGlobs', () => {
  it('undefined → defaults', () => {
    expect(parseIgnoreGlobs(undefined)).toEqual(DEFAULT_IGNORE_GLOBS);
  });

  it('comma-separated string', () => {
    expect(parseIgnoreGlobs('**/a/**, **/b/**')).toEqual(['**/a/**', '**/b/**']);
  });

  it('valid JSON array', () => {
    expect(parseIgnoreGlobs('["**/x/**"]')).toEqual(['**/x/**']);
  });
});

describe('parseStructurePreference / parseInsertOrderStrategy', () => {
  it('normalizes case and falls back to defaults', () => {
    expect(parseStructurePreference('FLAT')).toBe('flat');
    expect(parseStructurePreference('bogus')).toBe('auto');
    expect(parseInsertOrderStrategy('APPEND')).toBe('append');
    expect(parseInsertOrderStrategy('bogus')).toBe('nearby');
  });
});

describe('parseBooleanFlag', () => {
  it('accepts 1/true/yes/on and rejects everything else', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) expect(parseBooleanFlag(v)).toBe(true);
    for (const v of ['0', 'false', '', undefined, 'no']) expect(parseBooleanFlag(v)).toBe(false);
  });
});

describe('getEffectiveConfigFromEnv', () => {
  it('empty env → defaults', () => {
    const cfg = getEffectiveConfigFromEnv({});
    expect(cfg.resourceGlob).toBe(DEFAULT_RESOURCE_GLOB);
    expect(cfg.codeGlob).toBe(DEFAULT_CODE_GLOB);
    expect(cfg.ignoreGlobs).toEqual(DEFAULT_IGNORE_GLOBS);
    expect(cfg.structurePreference).toBe('auto');
    expect(cfg.insertOrderStrategy).toBe('nearby');
    expect(cfg.nsSeparator).toBe(':');
    expect(cfg.defaultNamespace).toBeUndefined();
    expect(cfg.allowAnyWorkspace).toBe(false);
    expect(cfg.customCodeRegex).toBe(false);
  });

  it('reads namespace and workspace flags from env', () => {
    const cfg = getEffectiveConfigFromEnv({
      I18N_NS_SEPARATOR: '.',
      I18N_DEFAULT_NS: 'common',
      I18N_ALLOW_ANY_WORKSPACE: 'true',
      I18N_CODE_REGEX: 'x(?<key>y)',
    });
    expect(cfg.nsSeparator).toBe('.');
    expect(cfg.defaultNamespace).toBe('common');
    expect(cfg.allowAnyWorkspace).toBe(true);
    expect(cfg.customCodeRegex).toBe(true);
  });

  it('custom I18N_GLOB / I18N_CODE_GLOB / I18N_STRUCTURE / I18N_INSERT_ORDER override', () => {
    const cfg = getEffectiveConfigFromEnv({
      I18N_GLOB: 'a/**/*.json',
      I18N_CODE_GLOB: '**/*.vue',
      I18N_STRUCTURE: 'nested',
      I18N_INSERT_ORDER: 'sort',
    });
    expect(cfg.resourceGlob).toBe('a/**/*.json');
    expect(cfg.codeGlob).toBe('**/*.vue');
    expect(cfg.structurePreference).toBe('nested');
    expect(cfg.insertOrderStrategy).toBe('sort');
  });
});
