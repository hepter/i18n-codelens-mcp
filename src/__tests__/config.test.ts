import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RESOURCE_GLOB,
  DEFAULT_CODE_GLOB,
  DEFAULT_IGNORE_GLOBS,
  DEFAULT_CODE_REGEX_PATTERN,
  DEFAULT_STRUCTURE_PREFERENCE,
  DEFAULT_INSERT_ORDER_STRATEGY,
  parseRegex,
  buildCodeRegex,
  parseIgnoreGlobs,
  parseStructurePreference,
  parseInsertOrderStrategy,
  getEffectiveConfigFromEnv,
} from '../config';

describe('defaults', () => {
  it('DEFAULT_RESOURCE_GLOB should include locales and json', () => {
    expect(DEFAULT_RESOURCE_GLOB).toContain('locales');
    expect(DEFAULT_RESOURCE_GLOB).toContain('.json');
  });

  it('DEFAULT_CODE_GLOB covers ts/tsx/js/jsx', () => {
    expect(DEFAULT_CODE_GLOB).toContain('ts');
    expect(DEFAULT_CODE_GLOB).toContain('jsx');
  });

  it('DEFAULT_IGNORE_GLOBS contains node_modules', () => {
    expect(DEFAULT_IGNORE_GLOBS).toContain('**/node_modules/**');
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
});

describe('parseRegex', () => {
  it('empty string → default regex with g flag', () => {
    const r = parseRegex('');
    expect(r).toBeInstanceOf(RegExp);
    expect(r.flags).toContain('g');
  });

  it('plain pattern → RegExp with g flag', () => {
    const r = parseRegex('hello');
    expect(r.source).toBe('hello');
    expect(r.flags).toContain('g');
  });

  it('/pattern/ syntax → correct source', () => {
    const r = parseRegex('/foo|bar/');
    expect(r.source).toBe('foo|bar');
    expect(r.flags).toContain('g');
  });

  it('/pattern/i syntax → preserves flags and adds g', () => {
    const r = parseRegex('/abc/i');
    expect(r.flags).toContain('i');
    expect(r.flags).toContain('g');
  });

  it('/pattern/gi syntax → no duplicate g', () => {
    const r = parseRegex('/abc/gi');
    expect(r.flags.split('').filter(f => f === 'g').length).toBe(1);
  });

  it('throws on invalid regex', () => {
    expect(() => parseRegex('/[invalid/')).toThrow();
  });
});

describe('buildCodeRegex', () => {
  it('undefined → default regex', () => {
    const r = buildCodeRegex(undefined);
    expect(r.flags).toContain('g');
  });

  it('empty string → default regex', () => {
    const r = buildCodeRegex('');
    expect(r.flags).toContain('g');
  });

  it('whitespace only → default regex', () => {
    const r = buildCodeRegex('   ');
    expect(r.flags).toContain('g');
  });

  it('custom pattern → used as-is', () => {
    const r = buildCodeRegex('custom');
    expect(r.source).toBe('custom');
  });
});

describe('parseIgnoreGlobs', () => {
  it('undefined → defaults', () => {
    expect(parseIgnoreGlobs(undefined)).toEqual(DEFAULT_IGNORE_GLOBS);
  });

  it('empty string → defaults', () => {
    expect(parseIgnoreGlobs('')).toEqual(DEFAULT_IGNORE_GLOBS);
  });

  it('comma-separated string', () => {
    expect(parseIgnoreGlobs('**/dist/**,**/build/**')).toEqual(['**/dist/**', '**/build/**']);
  });

  it('semicolon-separated string', () => {
    expect(parseIgnoreGlobs('**/dist/**;**/build/**')).toEqual(['**/dist/**', '**/build/**']);
  });

  it('valid JSON array', () => {
    expect(parseIgnoreGlobs('["**/dist/**","**/out/**"]')).toEqual(['**/dist/**', '**/out/**']);
  });

  it('invalid-looking value with items → splits', () => {
    expect(parseIgnoreGlobs('abc,def')).toEqual(['abc', 'def']);
  });
});

describe('parseStructurePreference', () => {
  it('undefined → auto', () => {
    expect(parseStructurePreference(undefined)).toBe('auto');
  });

  it('empty string → auto', () => {
    expect(parseStructurePreference('')).toBe('auto');
  });

  it('flat → flat', () => {
    expect(parseStructurePreference('flat')).toBe('flat');
  });

  it('FLAT → flat (case insensitive)', () => {
    expect(parseStructurePreference('FLAT')).toBe('flat');
  });

  it('nested → nested', () => {
    expect(parseStructurePreference('nested')).toBe('nested');
  });

  it('auto → auto', () => {
    expect(parseStructurePreference('auto')).toBe('auto');
  });

  it('unknown value → auto', () => {
    expect(parseStructurePreference('weird')).toBe('auto');
  });
});

describe('parseInsertOrderStrategy', () => {
  it('undefined → nearby', () => {
    expect(parseInsertOrderStrategy(undefined)).toBe('nearby');
  });

  it('empty string → nearby', () => {
    expect(parseInsertOrderStrategy('')).toBe('nearby');
  });

  it('append → append', () => {
    expect(parseInsertOrderStrategy('append')).toBe('append');
  });

  it('APPEND → append (case insensitive)', () => {
    expect(parseInsertOrderStrategy('APPEND')).toBe('append');
  });

  it('sort → sort', () => {
    expect(parseInsertOrderStrategy('sort')).toBe('sort');
  });

  it('nearby → nearby', () => {
    expect(parseInsertOrderStrategy('nearby')).toBe('nearby');
  });

  it('unknown value → nearby', () => {
    expect(parseInsertOrderStrategy('unknown')).toBe('nearby');
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
    expect(cfg.codeRegex).toBeInstanceOf(RegExp);
  });

  it('custom I18N_GLOB overrides resourceGlob', () => {
    const cfg = getEffectiveConfigFromEnv({ I18N_GLOB: '**/i18n/**/*.json' });
    expect(cfg.resourceGlob).toBe('**/i18n/**/*.json');
  });

  it('custom I18N_CODE_GLOB overrides codeGlob', () => {
    const cfg = getEffectiveConfigFromEnv({ I18N_CODE_GLOB: '**/*.vue' });
    expect(cfg.codeGlob).toBe('**/*.vue');
  });

  it('custom I18N_STRUCTURE overrides structurePreference', () => {
    const cfg = getEffectiveConfigFromEnv({ I18N_STRUCTURE: 'nested' });
    expect(cfg.structurePreference).toBe('nested');
  });

  it('custom I18N_INSERT_ORDER overrides insertOrderStrategy', () => {
    const cfg = getEffectiveConfigFromEnv({ I18N_INSERT_ORDER: 'sort' });
    expect(cfg.insertOrderStrategy).toBe('sort');
  });
});
