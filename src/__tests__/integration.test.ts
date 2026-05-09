/**
 * Integration tests using fixture projects.
 *
 * Fixture structure:
 *   fixtures/flat-project/   – en.json & tr.json with FLAT key structure (e.g. "nav.home")
 *     locales/en.json        – 11 keys (full set)
 *     locales/tr.json        – 7 keys (subset, one placeholder mismatch in msg.count)
 *     src/main.ts            – source file using t("key") calls including unknown keys
 *
 *   fixtures/nested-project/ – en.json & tr.json with NESTED JSON structure
 *     locales/en.json        – 13 flattened keys across nav/msg/btn/auth namespaces
 *     locales/tr.json        – 7 flattened keys (nav/msg/btn only, no auth.*)
 *     src/main.jsx           – JSX file using t("key") calls
 *
 * Write tests copy the fixture to a temp dir so originals are never modified.
 * Env vars I18N_GLOB and I18N_CODE_GLOB are set per describe block.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  toolCheckKeys,
  toolListLocales,
  toolGetTranslations,
  toolUpsertTranslations,
  toolDeleteKey,
  toolDiffLocales,
  toolRenameKey,
  toolMoveNamespace,
  toolValidatePlaceholders,
  toolScanWorkspaceMissing,
  toolKeyReferences,
} from '../server';
import { readResourceFiles } from '../i18nFs';

// ─── Constants ────────────────────────────────────────────────────────────────

const FIXTURES_ROOT = path.resolve(__dirname, '../../fixtures');
const FLAT_DIR = path.join(FIXTURES_ROOT, 'flat-project');
const NESTED_DIR = path.join(FIXTURES_ROOT, 'nested-project');
const GLOB = '**/locales/*.json';
const CODE_GLOB = 'src/**/*.{ts,tsx,js,jsx}';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

function cloneFixture(fixtureDir: string): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-int-'));
  copyDirSync(fixtureDir, tmp);
  return tmp;
}

/** Read the raw locale JSON content from a (possibly temp) locale dir. */
function localeContent(workspaceDir: string, locale: string): Record<string, unknown> {
  const file = path.join(workspaceDir, 'locales', `${locale}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ─────────────────────────────────────────────────────────────────────────────
// FLAT PROJECT
// ─────────────────────────────────────────────────────────────────────────────

describe('[flat-project] read-only – resource loading', () => {
  beforeAll(() => {
    process.env.I18N_GLOB = GLOB;
    process.env.I18N_CODE_GLOB = CODE_GLOB;
  });
  afterAll(() => {
    delete process.env.I18N_GLOB;
    delete process.env.I18N_CODE_GLOB;
  });

  it('detects 2 locale files', async () => {
    const resources = await readResourceFiles(GLOB, FLAT_DIR);
    expect(resources).toHaveLength(2);
  });

  it('all files are flat (isNested: false)', async () => {
    const resources = await readResourceFiles(GLOB, FLAT_DIR);
    expect(resources.every(r => r.isNested === false)).toBe(true);
  });

  it('en has 11 keys', async () => {
    const resources = await readResourceFiles(GLOB, FLAT_DIR);
    const en = resources.find(r => r.fileName === 'en')!;
    expect(Object.keys(en.keyValuePairs)).toHaveLength(11);
  });

  it('tr has 7 keys', async () => {
    const resources = await readResourceFiles(GLOB, FLAT_DIR);
    const tr = resources.find(r => r.fileName === 'tr')!;
    expect(Object.keys(tr.keyValuePairs)).toHaveLength(7);
  });

  it('en key values are correct', async () => {
    const resources = await readResourceFiles(GLOB, FLAT_DIR);
    const en = resources.find(r => r.fileName === 'en')!;
    expect(en.keyValuePairs['greeting']).toBe('Hello');
    expect(en.keyValuePairs['nav.home']).toBe('Home');
    expect(en.keyValuePairs['msg.welcome']).toBe('Welcome {{name}}!');
    expect(en.keyValuePairs['msg.count']).toBe('You have {count} items');
  });

  it('tr is missing nav.contact, msg.error, btn.cancel, btn.delete', async () => {
    const resources = await readResourceFiles(GLOB, FLAT_DIR);
    const tr = resources.find(r => r.fileName === 'tr')!;
    expect(tr.keyValuePairs['nav.contact']).toBeUndefined();
    expect(tr.keyValuePairs['msg.error']).toBeUndefined();
    expect(tr.keyValuePairs['btn.cancel']).toBeUndefined();
    expect(tr.keyValuePairs['btn.delete']).toBeUndefined();
  });

  it('results are sorted by file name', async () => {
    const resources = await readResourceFiles(GLOB, FLAT_DIR);
    const names = resources.map(r => r.fileName);
    expect(names).toEqual([...names].sort());
  });
});

describe('[flat-project] read-only – toolListLocales', () => {
  beforeAll(() => { process.env.I18N_GLOB = GLOB; });
  afterAll(() => { delete process.env.I18N_GLOB; });

  it('returns en and tr', async () => {
    const res = await toolListLocales({ workspaceDir: FLAT_DIR });
    expect(res.languages).toContain('en');
    expect(res.languages).toContain('tr');
  });

  it('en: 11 keys, isNested false', async () => {
    const res = await toolListLocales({ workspaceDir: FLAT_DIR });
    const en = res.locales.find(l => l.locale === 'en')!;
    expect(en.keyCount).toBe(11);
    expect(en.isNested).toBe(false);
  });

  it('tr: 7 keys, isNested false', async () => {
    const res = await toolListLocales({ workspaceDir: FLAT_DIR });
    const tr = res.locales.find(l => l.locale === 'tr')!;
    expect(tr.keyCount).toBe(7);
    expect(tr.isNested).toBe(false);
  });

  it('en description contains "English" (Intl.DisplayNames)', async () => {
    const res = await toolListLocales({ workspaceDir: FLAT_DIR });
    const en = res.locales.find(l => l.locale === 'en')!;
    if (en.description) expect(en.description.toLowerCase()).toContain('english');
  });
});

describe('[flat-project] read-only – toolCheckKeys', () => {
  beforeAll(() => { process.env.I18N_GLOB = GLOB; });
  afterAll(() => { delete process.env.I18N_GLOB; });

  it('greeting: true in both en and tr', async () => {
    const res = await toolCheckKeys({ keys: ['greeting'], workspaceDir: FLAT_DIR });
    expect(res['greeting']['en']).toBe(true);
    expect(res['greeting']['tr']).toBe(true);
  });

  it('nav.contact: true in en, false in tr', async () => {
    const res = await toolCheckKeys({ keys: ['nav.contact'], workspaceDir: FLAT_DIR });
    expect(res['nav.contact']['en']).toBe(true);
    expect(res['nav.contact']['tr']).toBe(false);
  });

  it('missing.key: false in both', async () => {
    const res = await toolCheckKeys({ keys: ['missing.key'], workspaceDir: FLAT_DIR });
    expect(res['missing.key']['en']).toBe(false);
    expect(res['missing.key']['tr']).toBe(false);
  });

  it('nav. prefix: true in both (any nav.* key exists)', async () => {
    const res = await toolCheckKeys({ keys: ['nav.'], workspaceDir: FLAT_DIR });
    expect(res['nav.']['en']).toBe(true);
    expect(res['nav.']['tr']).toBe(true);
  });

  it('auth. prefix: false in both (no auth.* keys)', async () => {
    const res = await toolCheckKeys({ keys: ['auth.'], workspaceDir: FLAT_DIR });
    expect(res['auth.']['en']).toBe(false);
    expect(res['auth.']['tr']).toBe(false);
  });

  it('multiple keys in one call returns all', async () => {
    const res = await toolCheckKeys({ keys: ['greeting', 'farewell', 'btn.delete'], workspaceDir: FLAT_DIR });
    expect(Object.keys(res)).toHaveLength(3);
    expect(res['greeting']['en']).toBe(true);
    expect(res['btn.delete']['tr']).toBe(false);
  });
});

describe('[flat-project] read-only – toolGetTranslations', () => {
  beforeAll(() => { process.env.I18N_GLOB = GLOB; });
  afterAll(() => { delete process.env.I18N_GLOB; });

  it('greeting: Hello (en) / Merhaba (tr)', async () => {
    const res = await toolGetTranslations({ keys: ['greeting'], workspaceDir: FLAT_DIR });
    expect(res.translations[0].values['en']).toBe('Hello');
    expect(res.translations[0].values['tr']).toBe('Merhaba');
  });

  it('nav.contact: Contact (en) / null (tr is missing it)', async () => {
    const res = await toolGetTranslations({ keys: ['nav.contact'], workspaceDir: FLAT_DIR });
    expect(res.translations[0].values['en']).toBe('Contact');
    expect(res.translations[0].values['tr']).toBeNull();
  });

  it('msg.welcome returns the full placeholder string', async () => {
    const res = await toolGetTranslations({ keys: ['msg.welcome'], workspaceDir: FLAT_DIR });
    expect(res.translations[0].values['en']).toBe('Welcome {{name}}!');
    expect(res.translations[0].values['tr']).toBe('Hoş geldin {{name}}!');
  });

  it('multiple keys returned in same order', async () => {
    const keys = ['greeting', 'farewell', 'nav.home'];
    const res = await toolGetTranslations({ keys, workspaceDir: FLAT_DIR });
    expect(res.translations.map(t => t.key)).toEqual(keys);
  });

  it('locale filter restricts results', async () => {
    const res = await toolGetTranslations({ keys: ['greeting'], locales: ['en'], workspaceDir: FLAT_DIR });
    expect(res.locales).toEqual(['en']);
    expect(res.translations[0].values['tr']).toBeUndefined();
  });

  it('throws for empty keys array', async () => {
    await expect(toolGetTranslations({ keys: [], workspaceDir: FLAT_DIR })).rejects.toThrow();
  });
});

describe('[flat-project] read-only – toolDiffLocales', () => {
  beforeAll(() => { process.env.I18N_GLOB = GLOB; });
  afterAll(() => { delete process.env.I18N_GLOB; });

  it('tr is missing nav.contact, msg.error, btn.cancel, btn.delete', async () => {
    const res = await toolDiffLocales({ base: 'en', compare: ['tr'], workspaceDir: FLAT_DIR });
    const tr = res.comparisons[0];
    expect(tr.missing).toContain('nav.contact');
    expect(tr.missing).toContain('msg.error');
    expect(tr.missing).toContain('btn.cancel');
    expect(tr.missing).toContain('btn.delete');
  });

  it('tr has no extra keys relative to en', async () => {
    const res = await toolDiffLocales({ base: 'en', compare: ['tr'], workspaceDir: FLAT_DIR });
    expect(res.comparisons[0].extra).toHaveLength(0);
  });

  it('msg.count: {count} in en vs {adet} in tr → placeholder mismatch', async () => {
    const res = await toolDiffLocales({ base: 'en', compare: ['tr'], workspaceDir: FLAT_DIR });
    const mismatch = res.comparisons[0].placeholderMismatches.find(m => m.key === 'msg.count');
    expect(mismatch).toBeDefined();
    expect(mismatch!.missing).toContain('count');
    expect(mismatch!.extra).toContain('adet');
  });

  it('msg.welcome has no placeholder mismatch (both have {{name}})', async () => {
    const res = await toolDiffLocales({ base: 'en', compare: ['tr'], workspaceDir: FLAT_DIR });
    const mismatch = res.comparisons[0].placeholderMismatches.find(m => m.key === 'msg.welcome');
    expect(mismatch).toBeUndefined();
  });

  it('throws for unknown base locale', async () => {
    await expect(toolDiffLocales({ base: 'de', compare: ['tr'], workspaceDir: FLAT_DIR })).rejects.toThrow();
  });
});

describe('[flat-project] read-only – toolValidatePlaceholders', () => {
  beforeAll(() => { process.env.I18N_GLOB = GLOB; });
  afterAll(() => { delete process.env.I18N_GLOB; });

  it('detects {count} → {adet} mismatch in msg.count', async () => {
    const res = await toolValidatePlaceholders({ baseLocale: 'en', workspaceDir: FLAT_DIR });
    const mismatch = res.mismatches.find(m => m.key === 'msg.count' && m.locale === 'tr');
    expect(mismatch).toBeDefined();
    expect(mismatch!.missing).toContain('count');
    expect(mismatch!.extra).toContain('adet');
  });

  it('msg.welcome: no mismatch (both have {{name}})', async () => {
    const res = await toolValidatePlaceholders({ baseLocale: 'en', workspaceDir: FLAT_DIR });
    const mismatch = res.mismatches.find(m => m.key === 'msg.welcome' && m.locale === 'tr');
    expect(mismatch).toBeUndefined();
  });

  it('returns keysChecked and baseLocale', async () => {
    const res = await toolValidatePlaceholders({ baseLocale: 'en', workspaceDir: FLAT_DIR });
    expect(res.keysChecked).toBeGreaterThan(0);
    expect(res.baseLocale).toBe('en');
  });

  it('specific key filter reduces keysChecked', async () => {
    const res = await toolValidatePlaceholders({
      keys: ['msg.count', 'msg.welcome'],
      baseLocale: 'en',
      workspaceDir: FLAT_DIR,
    });
    expect(res.keysChecked).toBe(2);
  });
});

describe('[flat-project] read-only – toolScanWorkspaceMissing', () => {
  beforeAll(() => {
    process.env.I18N_GLOB = GLOB;
    process.env.I18N_CODE_GLOB = CODE_GLOB;
  });
  afterAll(() => {
    delete process.env.I18N_GLOB;
    delete process.env.I18N_CODE_GLOB;
  });

  it('finds keys from code that are missing in at least one locale', async () => {
    const res = await toolScanWorkspaceMissing({ workspaceDir: FLAT_DIR });
    expect(res.totalMissing).toBeGreaterThan(0);
  });

  it('nav.contact appears (in en, missing in tr)', async () => {
    const res = await toolScanWorkspaceMissing({ workspaceDir: FLAT_DIR });
    const item = res.missing.find(m => m.key === 'nav.contact');
    expect(item).toBeDefined();
    expect(item!.missingLocales).toContain('tr');
    expect(item!.presentLocales).toContain('en');
  });

  it('missing.key is absent from both locales', async () => {
    const res = await toolScanWorkspaceMissing({ workspaceDir: FLAT_DIR });
    const item = res.missing.find(m => m.key === 'missing.key');
    if (item) {
      expect(item.missingLocales).toContain('en');
      expect(item.missingLocales).toContain('tr');
    }
  });
});

describe('[flat-project] read-only – toolKeyReferences', () => {
  beforeAll(() => {
    process.env.I18N_GLOB = GLOB;
    process.env.I18N_CODE_GLOB = CODE_GLOB;
  });
  afterAll(() => {
    delete process.env.I18N_GLOB;
    delete process.env.I18N_CODE_GLOB;
  });

  it('greeting is referenced in src/main.ts', async () => {
    const res = await toolKeyReferences({ keys: ['greeting'], limit: 5, workspaceDir: FLAT_DIR });
    expect(res['greeting'].total).toBeGreaterThan(0);
    expect(res['greeting'].references.some(r => r.filePath.includes('main.ts'))).toBe(true);
  });

  it('nav.home is referenced in src/main.ts', async () => {
    const res = await toolKeyReferences({ keys: ['nav.home'], limit: 5, workspaceDir: FLAT_DIR });
    expect(res['nav.home'].total).toBeGreaterThan(0);
  });

  it('nonexistent key has 0 references', async () => {
    const res = await toolKeyReferences({ keys: ['nonexistent.xyz.abc'], limit: 5, workspaceDir: FLAT_DIR });
    expect(res['nonexistent.xyz.abc'].total).toBe(0);
  });

  it('reference contains valid line and column numbers', async () => {
    const res = await toolKeyReferences({ keys: ['greeting'], limit: 5, workspaceDir: FLAT_DIR });
    const ref = res['greeting'].references[0];
    expect(ref.line).toBeGreaterThan(0);
    expect(ref.column).toBeGreaterThan(0);
  });

  it('multiple keys in single call, all resolved', async () => {
    const res = await toolKeyReferences({
      keys: ['greeting', 'farewell', 'btn.save'],
      limit: 3,
      workspaceDir: FLAT_DIR,
    });
    expect(Object.keys(res)).toHaveLength(3);
    expect(res['greeting'].total).toBeGreaterThan(0);
    expect(res['farewell'].total).toBeGreaterThan(0);
  });

  it('limit caps references per key', async () => {
    const res = await toolKeyReferences({ keys: ['greeting'], limit: 1, workspaceDir: FLAT_DIR });
    expect(res['greeting'].references.length).toBeLessThanOrEqual(1);
  });
});

// ─── FLAT write tests ─────────────────────────────────────────────────────────

describe('[flat-project] write – toolUpsertTranslations', () => {
  let tmpDir = '';
  beforeAll(() => { process.env.I18N_GLOB = GLOB; });
  afterAll(() => { delete process.env.I18N_GLOB; });
  beforeEach(() => { tmpDir = cloneFixture(FLAT_DIR); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('creates new key with created status', async () => {
    const res = await toolUpsertTranslations({
      entries: [{ key: 'brand.name', values: { en: 'Acme', tr: 'Akme' } }],
      dryRun: false,
      workspaceDir: tmpDir,
    });
    expect(res.summary.created).toBe(2);
    expect(localeContent(tmpDir, 'en')['brand.name']).toBe('Acme');
    expect(localeContent(tmpDir, 'tr')['brand.name']).toBe('Akme');
  });

  it('updates existing key and reports before/after', async () => {
    const res = await toolUpsertTranslations({
      entries: [{ key: 'greeting', values: { en: 'Hi!', tr: 'Selam!' } }],
      dryRun: false,
      workspaceDir: tmpDir,
    });
    expect(res.summary.updated).toBe(2);
    const detail = res.results.find(r => r.key === 'greeting' && r.locale === 'en')!;
    expect(detail.before).toBe('Hello');
    expect(detail.after).toBe('Hi!');
    expect(localeContent(tmpDir, 'en')['greeting']).toBe('Hi!');
  });

  it('unchanged value increments summary.unchanged', async () => {
    const res = await toolUpsertTranslations({
      entries: [{ key: 'greeting', values: { en: 'Hello' } }],
      dryRun: false,
      workspaceDir: tmpDir,
    });
    expect(res.summary.unchanged).toBe(1);
    expect(res.summary.updated).toBe(0);
  });

  it('dryRun does not persist changes', async () => {
    await toolUpsertTranslations({
      entries: [{ key: 'dry.key', values: { en: 'DryValue' } }],
      dryRun: true,
      workspaceDir: tmpDir,
    });
    expect(localeContent(tmpDir, 'en')['dry.key']).toBeUndefined();
  });

  it('fills missing locale key (tr gets nav.contact)', async () => {
    const res = await toolUpsertTranslations({
      entries: [{ key: 'nav.contact', values: { tr: 'İletişim' } }],
      dryRun: false,
      workspaceDir: tmpDir,
    });
    expect(res.summary.created).toBe(1);
    expect(localeContent(tmpDir, 'tr')['nav.contact']).toBe('İletişim');
    // en should be unaffected
    expect(localeContent(tmpDir, 'en')['nav.contact']).toBe('Contact');
  });

  it('multiple entries in single call', async () => {
    const res = await toolUpsertTranslations({
      entries: [
        { key: 'k1', values: { en: 'En1', tr: 'Tr1' } },
        { key: 'k2', values: { en: 'En2', tr: 'Tr2' } },
      ],
      dryRun: false,
      workspaceDir: tmpDir,
    });
    expect(res.summary.created).toBe(4);
    expect(localeContent(tmpDir, 'en')['k1']).toBe('En1');
    expect(localeContent(tmpDir, 'tr')['k2']).toBe('Tr2');
  });

  it('error reported for non-existent locale', async () => {
    const res = await toolUpsertTranslations({
      entries: [{ key: 'x', values: { de: 'Hallo' } }],
      workspaceDir: tmpDir,
    });
    expect(res.summary.errors).toBe(1);
  });
});

describe('[flat-project] write – toolDeleteKey', () => {
  let tmpDir = '';
  beforeAll(() => { process.env.I18N_GLOB = GLOB; });
  afterAll(() => { delete process.env.I18N_GLOB; });
  beforeEach(() => { tmpDir = cloneFixture(FLAT_DIR); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('deletes greeting from both locales', async () => {
    const res = await toolDeleteKey({ key: 'greeting', dryRun: false, workspaceDir: tmpDir });
    expect(res.deletedFrom).toHaveLength(2);
    expect(localeContent(tmpDir, 'en')['greeting']).toBeUndefined();
    expect(localeContent(tmpDir, 'tr')['greeting']).toBeUndefined();
  });

  it('nav.contact only deleted from en (tr does not have it)', async () => {
    const res = await toolDeleteKey({ key: 'nav.contact', dryRun: false, workspaceDir: tmpDir });
    expect(res.deletedFrom).toHaveLength(1);
    expect(localeContent(tmpDir, 'en')['nav.contact']).toBeUndefined();
  });

  it('locale filter: delete greeting only from tr', async () => {
    const res = await toolDeleteKey({ key: 'greeting', locales: ['tr'], dryRun: false, workspaceDir: tmpDir });
    expect(res.deletedFrom).toHaveLength(1);
    expect(localeContent(tmpDir, 'en')['greeting']).toBe('Hello');
    expect(localeContent(tmpDir, 'tr')['greeting']).toBeUndefined();
  });

  it('dryRun does not persist deletion', async () => {
    await toolDeleteKey({ key: 'farewell', dryRun: true, workspaceDir: tmpDir });
    expect(localeContent(tmpDir, 'en')['farewell']).toBe('Goodbye');
  });

  it('non-existent key → empty deletedFrom', async () => {
    const res = await toolDeleteKey({ key: 'doesnt.exist', workspaceDir: tmpDir });
    expect(res.deletedFrom).toHaveLength(0);
  });

  it('remaining keys still present after delete', async () => {
    await toolDeleteKey({ key: 'greeting', dryRun: false, workspaceDir: tmpDir });
    const en = localeContent(tmpDir, 'en') as Record<string, string>;
    expect(en['farewell']).toBe('Goodbye');
    expect(en['nav.home']).toBe('Home');
  });
});

describe('[flat-project] write – toolRenameKey', () => {
  let tmpDir = '';
  beforeAll(() => { process.env.I18N_GLOB = GLOB; });
  afterAll(() => { delete process.env.I18N_GLOB; });
  beforeEach(() => { tmpDir = cloneFixture(FLAT_DIR); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('renames greeting → salute in both locales, preserving values', async () => {
    const res = await toolRenameKey({ from: 'greeting', to: 'salute', dryRun: false, workspaceDir: tmpDir });
    expect(res.summary.renamed).toBe(2);
    expect(localeContent(tmpDir, 'en')['salute']).toBe('Hello');
    expect(localeContent(tmpDir, 'en')['greeting']).toBeUndefined();
    expect(localeContent(tmpDir, 'tr')['salute']).toBe('Merhaba');
  });

  it('skips locale where from key is absent (nav.contact not in tr)', async () => {
    const res = await toolRenameKey({ from: 'nav.contact', to: 'nav.reach', dryRun: false, workspaceDir: tmpDir });
    expect(res.summary.renamed).toBe(1);
    expect(res.summary.skipped).toBe(1);
    expect(localeContent(tmpDir, 'en')['nav.reach']).toBe('Contact');
  });

  it('errors if target key already exists', async () => {
    const res = await toolRenameKey({ from: 'greeting', to: 'farewell', workspaceDir: tmpDir });
    expect(res.summary.errors).toBeGreaterThan(0);
    // original should be preserved on error
    expect(localeContent(tmpDir, 'en')['greeting']).toBe('Hello');
  });

  it('dryRun does not persist', async () => {
    await toolRenameKey({ from: 'greeting', to: 'salute', dryRun: true, workspaceDir: tmpDir });
    expect(localeContent(tmpDir, 'en')['greeting']).toBe('Hello');
    expect(localeContent(tmpDir, 'en')['salute']).toBeUndefined();
  });

  it('locale filter: rename only in en', async () => {
    const res = await toolRenameKey({ from: 'greeting', to: 'salute', locales: ['en'], dryRun: false, workspaceDir: tmpDir });
    expect(res.summary.renamed).toBe(1);
    expect(localeContent(tmpDir, 'tr')['greeting']).toBe('Merhaba');
  });
});

describe('[flat-project] write – toolMoveNamespace', () => {
  let tmpDir = '';
  beforeAll(() => { process.env.I18N_GLOB = GLOB; });
  afterAll(() => { delete process.env.I18N_GLOB; });
  beforeEach(() => { tmpDir = cloneFixture(FLAT_DIR); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('moves nav.* → menu.* in both locales', async () => {
    const res = await toolMoveNamespace({ from: 'nav', to: 'menu', dryRun: false, workspaceDir: tmpDir });
    expect(res.summary.moved).toBeGreaterThan(0);
    const en = localeContent(tmpDir, 'en') as Record<string, string>;
    expect(en['menu.home']).toBe('Home');
    expect(en['menu.about']).toBe('About');
    expect(en['nav.home']).toBeUndefined();
  });

  it('tr nav.* keys are moved too', async () => {
    await toolMoveNamespace({ from: 'nav', to: 'menu', dryRun: false, workspaceDir: tmpDir });
    const tr = localeContent(tmpDir, 'tr') as Record<string, string>;
    expect(tr['menu.home']).toBe('Ana Sayfa');
    expect(tr['nav.home']).toBeUndefined();
  });

  it('non-nav keys remain untouched after move', async () => {
    await toolMoveNamespace({ from: 'nav', to: 'menu', dryRun: false, workspaceDir: tmpDir });
    const en = localeContent(tmpDir, 'en') as Record<string, string>;
    expect(en['greeting']).toBe('Hello');
    expect(en['btn.save']).toBe('Save');
  });

  it('dryRun does not persist move', async () => {
    await toolMoveNamespace({ from: 'nav', to: 'menu', dryRun: true, workspaceDir: tmpDir });
    const en = localeContent(tmpDir, 'en') as Record<string, string>;
    expect(en['nav.home']).toBe('Home');
    expect(en['menu.home']).toBeUndefined();
  });

  it('errors if destination key already exists', async () => {
    // Add a conflicting key first
    const content = localeContent(tmpDir, 'en') as Record<string, string>;
    content['menu.home'] = 'CONFLICT';
    fs.writeFileSync(path.join(tmpDir, 'locales', 'en.json'), JSON.stringify(content, null, 2) + '\n');
    const res = await toolMoveNamespace({ from: 'nav', to: 'menu', workspaceDir: tmpDir });
    const enResult = res.results.find(r => r.locale === 'en');
    expect(enResult!.result).toBe('error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// NESTED PROJECT
// ─────────────────────────────────────────────────────────────────────────────

describe('[nested-project] read-only – resource loading', () => {
  beforeAll(() => { process.env.I18N_GLOB = GLOB; });
  afterAll(() => { delete process.env.I18N_GLOB; });

  it('detects 2 locale files', async () => {
    const resources = await readResourceFiles(GLOB, NESTED_DIR);
    expect(resources).toHaveLength(2);
  });

  it('all files are nested (isNested: true)', async () => {
    const resources = await readResourceFiles(GLOB, NESTED_DIR);
    expect(resources.every(r => r.isNested === true)).toBe(true);
  });

  it('en has 13 flattened keys (nav×3, msg×4, btn×3, auth×3)', async () => {
    const resources = await readResourceFiles(GLOB, NESTED_DIR);
    const en = resources.find(r => r.fileName === 'en')!;
    expect(Object.keys(en.keyValuePairs)).toHaveLength(13);
  });

  it('tr has 7 flattened keys', async () => {
    const resources = await readResourceFiles(GLOB, NESTED_DIR);
    const tr = resources.find(r => r.fileName === 'tr')!;
    expect(Object.keys(tr.keyValuePairs)).toHaveLength(7);
  });

  it('nested structure is flattened with dots', async () => {
    const resources = await readResourceFiles(GLOB, NESTED_DIR);
    const en = resources.find(r => r.fileName === 'en')!;
    expect(en.keyValuePairs['nav.home']).toBe('Home');
    expect(en.keyValuePairs['msg.welcome']).toBe('Welcome {{name}}!');
    expect(en.keyValuePairs['auth.login']).toBe('Log in');
    expect(en.keyValuePairs['auth.register']).toBe('Register');
  });

  it('tr is missing auth.*, nav.contact, msg.error, btn.delete (msg.count present with {adet} mismatch)', async () => {
    const resources = await readResourceFiles(GLOB, NESTED_DIR);
    const tr = resources.find(r => r.fileName === 'tr')!;
    expect(tr.keyValuePairs['auth.login']).toBeUndefined();
    expect(tr.keyValuePairs['nav.contact']).toBeUndefined();
    expect(tr.keyValuePairs['msg.error']).toBeUndefined();
    expect(tr.keyValuePairs['btn.delete']).toBeUndefined();
    // msg.count IS present but uses {adet} instead of {count}
    expect(tr.keyValuePairs['msg.count']).toBeDefined();
    expect(tr.keyValuePairs['msg.count']).toContain('{adet}');
  });
});

describe('[nested-project] read-only – toolListLocales', () => {
  beforeAll(() => { process.env.I18N_GLOB = GLOB; });
  afterAll(() => { delete process.env.I18N_GLOB; });

  it('both locales have isNested: true', async () => {
    const res = await toolListLocales({ workspaceDir: NESTED_DIR });
    for (const l of res.locales) expect(l.isNested).toBe(true);
  });

  it('en has 13 keys', async () => {
    const res = await toolListLocales({ workspaceDir: NESTED_DIR });
    expect(res.locales.find(l => l.locale === 'en')!.keyCount).toBe(13);
  });

  it('tr has 7 keys', async () => {
    const res = await toolListLocales({ workspaceDir: NESTED_DIR });
    expect(res.locales.find(l => l.locale === 'tr')!.keyCount).toBe(7);
  });
});

describe('[nested-project] read-only – toolCheckKeys', () => {
  beforeAll(() => { process.env.I18N_GLOB = GLOB; });
  afterAll(() => { delete process.env.I18N_GLOB; });

  it('nav.home: true in both', async () => {
    const res = await toolCheckKeys({ keys: ['nav.home'], workspaceDir: NESTED_DIR });
    expect(res['nav.home']['en']).toBe(true);
    expect(res['nav.home']['tr']).toBe(true);
  });

  it('auth.login: true in en, false in tr', async () => {
    const res = await toolCheckKeys({ keys: ['auth.login'], workspaceDir: NESTED_DIR });
    expect(res['auth.login']['en']).toBe(true);
    expect(res['auth.login']['tr']).toBe(false);
  });

  it('auth. prefix: en has it, tr does not', async () => {
    const res = await toolCheckKeys({ keys: ['auth.'], workspaceDir: NESTED_DIR });
    expect(res['auth.']['en']).toBe(true);
    expect(res['auth.']['tr']).toBe(false);
  });

  it('nav. prefix: both have it', async () => {
    const res = await toolCheckKeys({ keys: ['nav.'], workspaceDir: NESTED_DIR });
    expect(res['nav.']['en']).toBe(true);
    expect(res['nav.']['tr']).toBe(true);
  });
});

describe('[nested-project] read-only – toolGetTranslations', () => {
  beforeAll(() => { process.env.I18N_GLOB = GLOB; });
  afterAll(() => { delete process.env.I18N_GLOB; });

  it('nav.home: Home (en) / Ana Sayfa (tr)', async () => {
    const res = await toolGetTranslations({ keys: ['nav.home'], workspaceDir: NESTED_DIR });
    expect(res.translations[0].values['en']).toBe('Home');
    expect(res.translations[0].values['tr']).toBe('Ana Sayfa');
  });

  it('auth.login: Log in (en) / null (tr)', async () => {
    const res = await toolGetTranslations({ keys: ['auth.login'], workspaceDir: NESTED_DIR });
    expect(res.translations[0].values['en']).toBe('Log in');
    expect(res.translations[0].values['tr']).toBeNull();
  });

  it('msg.welcome placeholder preserved', async () => {
    const res = await toolGetTranslations({ keys: ['msg.welcome'], workspaceDir: NESTED_DIR });
    expect(res.translations[0].values['en']).toBe('Welcome {{name}}!');
    expect(res.translations[0].values['tr']).toBe('Hoş geldin {{name}}!');
  });
});

describe('[nested-project] read-only – toolDiffLocales', () => {
  beforeAll(() => { process.env.I18N_GLOB = GLOB; });
  afterAll(() => { delete process.env.I18N_GLOB; });

  it('tr missing: nav.contact, msg.error, btn.delete, auth.*; msg.count present with placeholder mismatch', async () => {
    const res = await toolDiffLocales({ base: 'en', compare: ['tr'], workspaceDir: NESTED_DIR });
    const tr = res.comparisons[0];
    expect(tr.missing).toContain('nav.contact');
    expect(tr.missing).toContain('msg.error');
    expect(tr.missing).toContain('btn.delete');
    expect(tr.missing).toContain('auth.login');
    expect(tr.missing).toContain('auth.logout');
    expect(tr.missing).toContain('auth.register');
    // msg.count is NOT in missing (it exists in tr); it appears in placeholderMismatches
    expect(tr.missing).not.toContain('msg.count');
    const mismatch = tr.placeholderMismatches.find(m => m.key === 'msg.count');
    expect(mismatch).toBeDefined();
    expect(mismatch!.missing).toContain('count');
    expect(mismatch!.extra).toContain('adet');
  });

  it('tr has no extra keys', async () => {
    const res = await toolDiffLocales({ base: 'en', compare: ['tr'], workspaceDir: NESTED_DIR });
    expect(res.comparisons[0].extra).toHaveLength(0);
  });

  it('msg.welcome: no placeholder mismatch', async () => {
    const res = await toolDiffLocales({ base: 'en', compare: ['tr'], workspaceDir: NESTED_DIR });
    const mismatch = res.comparisons[0].placeholderMismatches.find(m => m.key === 'msg.welcome');
    expect(mismatch).toBeUndefined();
  });
});

describe('[nested-project] read-only – toolValidatePlaceholders', () => {
  beforeAll(() => { process.env.I18N_GLOB = GLOB; });
  afterAll(() => { delete process.env.I18N_GLOB; });

  it('msg.welcome: {{name}} in both → no mismatch', async () => {
    const res = await toolValidatePlaceholders({ baseLocale: 'en', workspaceDir: NESTED_DIR });
    const mismatch = res.mismatches.find(m => m.key === 'msg.welcome' && m.locale === 'tr');
    expect(mismatch).toBeUndefined();
  });

  it('only checks shared keys (missing keys are not in mismatches)', async () => {
    const res = await toolValidatePlaceholders({ baseLocale: 'en', workspaceDir: NESTED_DIR });
    // auth.login is missing from tr entirely, should NOT appear as a placeholder mismatch
    const mismatch = res.mismatches.find(m => m.key === 'auth.login');
    expect(mismatch).toBeUndefined();
  });
});

describe('[nested-project] read-only – toolScanWorkspaceMissing', () => {
  beforeAll(() => {
    process.env.I18N_GLOB = GLOB;
    process.env.I18N_CODE_GLOB = CODE_GLOB;
  });
  afterAll(() => {
    delete process.env.I18N_GLOB;
    delete process.env.I18N_CODE_GLOB;
  });

  it('finds code keys missing from at least one locale', async () => {
    const res = await toolScanWorkspaceMissing({ workspaceDir: NESTED_DIR });
    expect(res.totalMissing).toBeGreaterThan(0);
  });

  it('auth.login appears (in en, not in tr)', async () => {
    const res = await toolScanWorkspaceMissing({ workspaceDir: NESTED_DIR });
    const item = res.missing.find(m => m.key === 'auth.login');
    expect(item).toBeDefined();
    expect(item!.missingLocales).toContain('tr');
    expect(item!.presentLocales).toContain('en');
  });

  it('unknown.widget.title is missing from both', async () => {
    const res = await toolScanWorkspaceMissing({ workspaceDir: NESTED_DIR });
    const item = res.missing.find(m => m.key === 'unknown.widget.title');
    if (item) {
      expect(item.missingLocales).toContain('en');
      expect(item.missingLocales).toContain('tr');
    }
  });
});

describe('[nested-project] read-only – toolKeyReferences', () => {
  beforeAll(() => {
    process.env.I18N_GLOB = GLOB;
    process.env.I18N_CODE_GLOB = CODE_GLOB;
  });
  afterAll(() => {
    delete process.env.I18N_GLOB;
    delete process.env.I18N_CODE_GLOB;
  });

  it('nav.home is referenced in main.jsx', async () => {
    const res = await toolKeyReferences({ keys: ['nav.home'], limit: 5, workspaceDir: NESTED_DIR });
    expect(res['nav.home'].total).toBeGreaterThan(0);
    expect(res['nav.home'].references.some(r => r.filePath.includes('main.jsx'))).toBe(true);
  });

  it('auth.register referenced in main.jsx', async () => {
    const res = await toolKeyReferences({ keys: ['auth.register'], limit: 5, workspaceDir: NESTED_DIR });
    expect(res['auth.register'].total).toBeGreaterThan(0);
  });

  it('reference line/column numbers are positive integers', async () => {
    const res = await toolKeyReferences({ keys: ['nav.home'], limit: 1, workspaceDir: NESTED_DIR });
    const ref = res['nav.home'].references[0];
    expect(Number.isInteger(ref.line)).toBe(true);
    expect(Number.isInteger(ref.column)).toBe(true);
    expect(ref.line).toBeGreaterThan(0);
    expect(ref.column).toBeGreaterThan(0);
  });
});

// ─── NESTED write tests ───────────────────────────────────────────────────────

describe('[nested-project] write – toolUpsertTranslations', () => {
  let tmpDir = '';
  beforeAll(() => { process.env.I18N_GLOB = GLOB; });
  afterAll(() => { delete process.env.I18N_GLOB; });
  beforeEach(() => { tmpDir = cloneFixture(NESTED_DIR); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('writes auth.login to tr and nested structure is preserved in output', async () => {
    const res = await toolUpsertTranslations({
      entries: [{ key: 'auth.login', values: { tr: 'Giriş Yap' } }],
      dryRun: false,
      workspaceDir: tmpDir,
    });
    expect(res.summary.created).toBe(1);
    // verify via readResourceFiles (flattens nested JSON back)
    const resources = await readResourceFiles(GLOB, tmpDir);
    const tr = resources.find(r => r.fileName === 'tr')!;
    expect(tr.keyValuePairs['auth.login']).toBe('Giriş Yap');
  });

  it('bulk upsert: creates auth.login, auth.logout, auth.register in tr', async () => {
    const res = await toolUpsertTranslations({
      entries: [
        { key: 'auth.login', values: { tr: 'Giriş Yap' } },
        { key: 'auth.logout', values: { tr: 'Çıkış Yap' } },
        { key: 'auth.register', values: { tr: 'Kayıt Ol' } },
      ],
      dryRun: false,
      workspaceDir: tmpDir,
    });
    expect(res.summary.created).toBe(3);
    const resources = await readResourceFiles(GLOB, tmpDir);
    const tr = resources.find(r => r.fileName === 'tr')!;
    expect(tr.keyValuePairs['auth.login']).toBe('Giriş Yap');
    expect(tr.keyValuePairs['auth.logout']).toBe('Çıkış Yap');
    expect(tr.keyValuePairs['auth.register']).toBe('Kayıt Ol');
  });

  it('updates existing nested key (nav.home) in both locales', async () => {
    const res = await toolUpsertTranslations({
      entries: [{ key: 'nav.home', values: { en: 'Dashboard', tr: 'Kontrol Paneli' } }],
      dryRun: false,
      workspaceDir: tmpDir,
    });
    expect(res.summary.updated).toBe(2);
    const resources = await readResourceFiles(GLOB, tmpDir);
    expect(resources.find(r => r.fileName === 'en')!.keyValuePairs['nav.home']).toBe('Dashboard');
    expect(resources.find(r => r.fileName === 'tr')!.keyValuePairs['nav.home']).toBe('Kontrol Paneli');
  });
});

describe('[nested-project] write – toolDeleteKey', () => {
  let tmpDir = '';
  beforeAll(() => { process.env.I18N_GLOB = GLOB; });
  afterAll(() => { delete process.env.I18N_GLOB; });
  beforeEach(() => { tmpDir = cloneFixture(NESTED_DIR); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('deletes nav.home from both locales', async () => {
    const res = await toolDeleteKey({ key: 'nav.home', dryRun: false, workspaceDir: tmpDir });
    expect(res.deletedFrom).toHaveLength(2);
    const resources = await readResourceFiles(GLOB, tmpDir);
    for (const r of resources) {
      expect(r.keyValuePairs['nav.home']).toBeUndefined();
    }
  });

  it('auth.login only in en → deleted from 1 locale', async () => {
    const res = await toolDeleteKey({ key: 'auth.login', dryRun: false, workspaceDir: tmpDir });
    expect(res.deletedFrom).toHaveLength(1);
    const resources = await readResourceFiles(GLOB, tmpDir);
    expect(resources.find(r => r.fileName === 'en')!.keyValuePairs['auth.login']).toBeUndefined();
  });
});

describe('[nested-project] write – toolRenameKey', () => {
  let tmpDir = '';
  beforeAll(() => { process.env.I18N_GLOB = GLOB; });
  afterAll(() => { delete process.env.I18N_GLOB; });
  beforeEach(() => { tmpDir = cloneFixture(NESTED_DIR); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('renames nav.home → nav.main in both locales', async () => {
    const res = await toolRenameKey({ from: 'nav.home', to: 'nav.main', dryRun: false, workspaceDir: tmpDir });
    expect(res.summary.renamed).toBe(2);
    const resources = await readResourceFiles(GLOB, tmpDir);
    const en = resources.find(r => r.fileName === 'en')!;
    expect(en.keyValuePairs['nav.main']).toBe('Home');
    expect(en.keyValuePairs['nav.home']).toBeUndefined();
  });

  it('auth.login (en-only) rename: 1 renamed, 1 skipped for tr', async () => {
    const res = await toolRenameKey({ from: 'auth.login', to: 'auth.signin', dryRun: false, workspaceDir: tmpDir });
    expect(res.summary.renamed).toBe(1);
    expect(res.summary.skipped).toBe(1);
  });
});

describe('[nested-project] write – toolMoveNamespace', () => {
  let tmpDir = '';
  beforeAll(() => { process.env.I18N_GLOB = GLOB; });
  afterAll(() => { delete process.env.I18N_GLOB; });
  beforeEach(() => { tmpDir = cloneFixture(NESTED_DIR); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('moves auth.* → account.* in en', async () => {
    const res = await toolMoveNamespace({ from: 'auth', to: 'account', dryRun: false, workspaceDir: tmpDir });
    const enResult = res.results.find(r => r.locale === 'en');
    expect(enResult!.result).toBe('moved');
    const resources = await readResourceFiles(GLOB, tmpDir);
    const en = resources.find(r => r.fileName === 'en')!;
    expect(en.keyValuePairs['account.login']).toBe('Log in');
    expect(en.keyValuePairs['auth.login']).toBeUndefined();
  });

  it('tr has no auth.* → tr result is skipped', async () => {
    const res = await toolMoveNamespace({ from: 'auth', to: 'account', dryRun: false, workspaceDir: tmpDir });
    const trResult = res.results.find(r => r.locale === 'tr');
    expect(trResult!.result).toBe('skipped');
  });

  it('summary counts moved keys not locales', async () => {
    const res = await toolMoveNamespace({ from: 'auth', to: 'account', dryRun: false, workspaceDir: tmpDir });
    // en has auth.login, auth.logout, auth.register → 3 keys moved
    expect(res.summary.moved).toBe(3);
  });

  it('moves btn.* → action.* across both locales', async () => {
    await toolMoveNamespace({ from: 'btn', to: 'action', dryRun: false, workspaceDir: tmpDir });
    const resources = await readResourceFiles(GLOB, tmpDir);
    const en = resources.find(r => r.fileName === 'en')!;
    expect(en.keyValuePairs['action.save']).toBe('Save');
    expect(en.keyValuePairs['btn.save']).toBeUndefined();
    const tr = resources.find(r => r.fileName === 'tr')!;
    expect(tr.keyValuePairs['action.save']).toBe('Kaydet');
  });

  it('dryRun: no changes persisted', async () => {
    await toolMoveNamespace({ from: 'auth', to: 'account', dryRun: true, workspaceDir: tmpDir });
    const resources = await readResourceFiles(GLOB, tmpDir);
    const en = resources.find(r => r.fileName === 'en')!;
    expect(en.keyValuePairs['auth.login']).toBe('Log in');
    expect(en.keyValuePairs['account.login']).toBeUndefined();
  });
});
