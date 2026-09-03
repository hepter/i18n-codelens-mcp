import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import { createToolContext } from '../tools/shared';
import { toolProjectInfo } from '../tools/project-info';
import { toolGetTranslations } from '../tools/get-translations';
import { toolSearchKeys } from '../tools/search-keys';
import { toolFileKeys } from '../tools/file-keys';
import { toolKeyReferences } from '../tools/key-references';
import { clearResourceCache } from '../core/resources';
import { clearCodeIndexCache } from '../core/code-index';

const FIXTURES = path.resolve(__dirname, '..', '..', 'fixtures');
const flat = () => createToolContext({ workspaceRoot: path.join(FIXTURES, 'flat-project'), env: {} });
const namespaced = () => createToolContext({ workspaceRoot: path.join(FIXTURES, 'namespaced-project'), env: {} });

beforeEach(() => {
  clearResourceCache();
  clearCodeIndexCache();
});

describe('createToolContext', () => {
  it('resolves the root and refuses a workspaceDir outside it', () => {
    const ctx = createToolContext({ workspaceRoot: path.join(FIXTURES, 'flat-project'), workspaceDir: 'src', env: {} });
    expect(ctx.root).toBe(path.join(FIXTURES, 'flat-project', 'src'));
    expect(() => createToolContext({ workspaceRoot: path.join(FIXTURES, 'flat-project'), workspaceDir: FIXTURES, env: {} })).toThrow(/outside/);
  });
});

describe('i18n_project_info', () => {
  it('summarises locales, key counts and config for a flat project', async () => {
    const info = await toolProjectInfo({}, flat());
    expect(info.keyFormat).toBe('key');
    expect(info.locales).toEqual([
      { locale: 'en', name: 'English', files: ['locales/en.json'], keys: 11, structure: 'flat' },
      { locale: 'tr', name: 'Turkish', files: ['locales/tr.json'], keys: 7, structure: 'flat' },
    ]);
    expect(info.totals).toEqual({ locales: 2, keys: 11 });
    expect(info.config.codeRegex).toBe('default');
    expect(info).not.toHaveProperty('warnings');
    expect(info).not.toHaveProperty('namespaces');
  });

  it('explains the namespace key format for a {locale}/{ns}.json project', async () => {
    const info = await toolProjectInfo({}, namespaced());
    expect(info.keyFormat).toBe('namespace:key');
    expect(info.namespaces).toEqual(['auth', 'common']);
    expect(info.locales[0].files).toEqual(['locales/en/auth.json', 'locales/en/common.json']);
  });

  it('fails with a helpful message when no locale files match', async () => {
    const ctx = createToolContext({ workspaceRoot: path.join(FIXTURES, 'flat-project', 'src'), env: {} });
    await expect(toolProjectInfo({}, ctx)).rejects.toThrow(/No i18n resource files found.*I18N_GLOB/s);
  });
});

describe('i18n_get_translations', () => {
  it('returns values per locale with null for a missing translation', async () => {
    const out = await toolGetTranslations({ keys: ['greeting', 'nav.contact'] }, flat());
    expect(out.locales).toEqual(['en', 'tr']);
    expect(out.translations).toEqual({
      greeting: { en: 'Hello', tr: 'Merhaba' },
      'nav.contact': { en: 'Contact', tr: null },
    });
    expect(out).not.toHaveProperty('notFound');
  });

  it('lists keys that exist in no locale separately', async () => {
    const out = await toolGetTranslations({ keys: ['greeting', 'nope.key'] }, flat());
    expect(Object.keys(out.translations)).toEqual(['greeting']);
    expect(out.notFound).toEqual(['nope.key']);
  });

  it('expands a trailing-dot key to the whole namespace, sorted and limited', async () => {
    const out = await toolGetTranslations({ keys: ['nav.'], limit: 2 }, flat());
    expect(Object.keys(out.translations)).toEqual(['nav.about', 'nav.contact']);
    expect(out.total).toBe(3);
    expect(out.truncated).toBe(true);
  });

  it('filters locales and reports unknown ones', async () => {
    const out = await toolGetTranslations({ keys: ['greeting'], locales: ['tr', 'de'] }, flat());
    expect(out.locales).toEqual(['tr']);
    expect(out.unknownLocales).toEqual(['de']);
    expect(out.translations.greeting).toEqual({ tr: 'Merhaba' });
  });

  it('errors when none of the requested locales exist, naming the available ones', async () => {
    await expect(toolGetTranslations({ keys: ['greeting'], locales: ['de'] }, flat())).rejects.toThrow(/Available locales: en, tr/);
  });

  it('can return presence only, and truncates long values', async () => {
    const presence = await toolGetTranslations({ keys: ['nav.contact'], includeValues: false }, flat());
    expect(presence.translations).toEqual({ 'nav.contact': ['en'] });
    const short = await toolGetTranslations({ keys: ['msg.welcome'], maxValueChars: 8 }, flat());
    expect((short.translations['msg.welcome'] as Record<string, string | null>).en).toBe('Welcome…');
  });

  it('works with namespaced keys', async () => {
    const out = await toolGetTranslations({ keys: ['auth:login.title', 'common:'] }, namespaced());
    expect(out.translations['auth:login.title']).toEqual({ en: 'Log in', tr: 'Giriş yap' });
    expect(Object.keys(out.translations)).toContain('common:nav.home');
  });

  it('rejects an empty key list', async () => {
    await expect(toolGetTranslations({ keys: [] }, flat())).rejects.toThrow(/at least one key/);
  });
});

describe('i18n_search_keys', () => {
  it('finds keys by substring and marks the ones not present everywhere', async () => {
    const out = await toolSearchKeys({ query: 'nav', searchIn: 'keys' }, flat());
    expect(out.total).toBe(3);
    expect(out.matches).toEqual([{ key: 'nav.about' }, { key: 'nav.contact', in: ['en'] }, { key: 'nav.home' }]);
    expect(out).not.toHaveProperty('truncated');
  });

  it('searches values case-insensitively by default and includes previews on request', async () => {
    const out = await toolSearchKeys({ query: 'MERHABA', searchIn: 'values', includeValues: true }, flat());
    expect(out.matches).toEqual([{ key: 'greeting', values: { en: 'Hello', tr: 'Merhaba' } }]);
    const strict = await toolSearchKeys({ query: 'MERHABA', searchIn: 'values', caseSensitive: true }, flat());
    expect(strict.total).toBe(0);
  });

  it('supports keyPrefix alone and limits results', async () => {
    const out = await toolSearchKeys({ keyPrefix: 'btn.', limit: 2 }, flat());
    expect(out.total).toBe(3);
    expect(out.truncated).toBe(true);
    expect(out.matches.map(m => m.key)).toEqual(['btn.cancel', 'btn.delete']);
  });

  it('requires a query or a prefix', async () => {
    await expect(toolSearchKeys({}, flat())).rejects.toThrow(/query or keyPrefix/);
  });
});

describe('i18n_file_keys', () => {
  it('lists the keys a source file uses and which locales miss them', async () => {
    const out = await toolFileKeys({ filePath: 'src/main.ts' }, flat());
    expect(out.file).toBe('src/main.ts');
    expect(out.total).toBe(13);
    expect(out.missing).toEqual({
      'nav.contact': ['tr'],
      'msg.error': ['tr'],
      'btn.cancel': ['tr'],
      'btn.delete': ['tr'],
      'missing.key': ['en', 'tr'],
      'another.missing': ['en', 'tr'],
    });
    expect(out.complete).toBe(7);
  });

  it('can list the complete keys too', async () => {
    const out = await toolFileKeys({ filePath: 'src/main.ts', includeComplete: true }, flat());
    expect(out.complete).toEqual(['greeting', 'farewell', 'nav.home', 'nav.about', 'msg.welcome', 'msg.count', 'btn.save']);
  });

  it('refuses a file outside the workspace and reports a missing file', async () => {
    await expect(toolFileKeys({ filePath: '../nested-project/src/main.jsx' }, flat())).rejects.toThrow(/outside/);
    await expect(toolFileKeys({ filePath: 'src/nope.ts' }, flat())).rejects.toThrow(/not found/i);
  });
});

describe('i18n_key_references', () => {
  it('returns compact path:line:column references and totals', async () => {
    const out = await toolKeyReferences({ keys: ['greeting', 'nope.key'] }, flat());
    expect(out).toEqual({
      greeting: { total: 1, refs: ['src/main.ts:4:21'] },
      'nope.key': { total: 0 },
    });
  });

  it('caps references per key with limit but keeps totals', async () => {
    const out = await toolKeyReferences({ keys: ['common:nav.home'], limit: 1 }, namespaced());
    expect(out['common:nav.home'].total).toBe(1);
    expect(out['common:nav.home'].refs).toHaveLength(1);
  });
});
