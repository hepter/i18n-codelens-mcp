import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  normalizeLocaleTag,
  describeLocale,
  extractPlaceholders,
  relativeToWorkspace,
  createResourceState,
  getValueFromState,
  applyValueToState,
  deleteKeyFromState,
  listKeysFromState,
  toolProjectInfo,
  toolSearchKeys,
  toolGetNamespace,
  toolUnusedKeys,
  toolAudit,
  toolFormatResources,
  toolCheckKeys,
  toolListLocales,
  toolGetTranslations,
  toolUpsertTranslations,
  toolDeleteKey,
  toolDiffLocales,
  toolRenameKey,
  toolMoveNamespace,
  toolValidatePlaceholders,
  toolUntranslatedKeysOnPage,
} from '../server';

// ─── Temp directory fixture helpers ─────────────────────────────────────────

let tmpDir = '';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-server-test-'));
}

function makeLocaleDir(base: string = tmpDir) {
  const dir = path.join(base, 'locales');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeLocale(fileName: string, content: Record<string, unknown>, localeDir?: string) {
  const dir = localeDir ?? path.join(tmpDir, 'locales');
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, JSON.stringify(content, null, 2) + '\n', 'utf8');
  return file;
}

function writeSource(rel: string, content: string) {
  const file = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

beforeEach(() => {
  tmpDir = makeTmpDir();
  makeLocaleDir();
  // Use tmpDir as workspace root for all tools
  process.env.WORKSPACE_ROOT = tmpDir;
  process.env.I18N_GLOB = '**/locales/**/*.json';
  process.env.I18N_CODE_GLOB = '**/*.{ts,tsx,js,jsx}';
});

afterEach(() => {
  delete process.env.WORKSPACE_ROOT;
  delete process.env.I18N_GLOB;
  delete process.env.I18N_CODE_GLOB;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── normalizeLocaleTag ──────────────────────────────────────────────────────

describe('normalizeLocaleTag', () => {
  it('empty string → empty string', () => {
    expect(normalizeLocaleTag('')).toBe('');
  });

  it('simple language code → lowercase', () => {
    expect(normalizeLocaleTag('EN')).toBe('en');
  });

  it('language-REGION → normalized', () => {
    expect(normalizeLocaleTag('en-US')).toBe('en-US');
    expect(normalizeLocaleTag('en-us')).toBe('en-US');
    expect(normalizeLocaleTag('en_us')).toBe('en-US');
  });

  it('strips .json extension', () => {
    expect(normalizeLocaleTag('en.json')).toBe('en');
    expect(normalizeLocaleTag('en-US.json')).toBe('en-US');
  });

  it('handles zh-Hans-CN', () => {
    const tag = normalizeLocaleTag('zh-Hans-CN');
    expect(tag).toBe('zh-Hans-CN');
  });
});

// ─── describeLocale ──────────────────────────────────────────────────────────

describe('describeLocale', () => {
  it('returns string or undefined for valid locale', () => {
    const result = describeLocale('en');
    expect(result === undefined || typeof result === 'string').toBe(true);
  });

  it('returns English description for en', () => {
    const result = describeLocale('en');
    if (result) expect(result.toLowerCase()).toContain('english');
  });

  it('does not throw for unknown tag', () => {
    expect(() => describeLocale('x-unknown-zz')).not.toThrow();
  });
});

// ─── extractPlaceholders ─────────────────────────────────────────────────────

describe('extractPlaceholders', () => {
  it('empty string → empty set', () => {
    expect(extractPlaceholders('')).toEqual(new Set());
  });

  it('undefined string → empty set', () => {
    expect(extractPlaceholders(undefined)).toEqual(new Set());
  });

  it('{{name}} placeholder found', () => {
    const result = extractPlaceholders('Hello {{name}}!');
    expect(result).toContain('name');
  });

  it('{count} placeholder found', () => {
    const result = extractPlaceholders('You have {count} messages');
    expect(result).toContain('count');
  });

  it('mixed placeholders', () => {
    const result = extractPlaceholders('{{first}} and {second}');
    expect(result).toContain('first');
    expect(result).toContain('second');
  });

  it('no placeholders → empty set', () => {
    expect(extractPlaceholders('plain text')).toEqual(new Set());
  });
});

// ─── relativeToWorkspace ─────────────────────────────────────────────────────

describe('relativeToWorkspace', () => {
  it('returns relative path inside workspace', () => {
    const abs = path.join(tmpDir, 'locales', 'en.json');
    const relative = relativeToWorkspace(abs, tmpDir);
    expect(relative).not.toContain(tmpDir);
    expect(relative).toContain('locales');
  });

  it('returns absolute path for files outside workspace', () => {
    const outside = path.join(os.tmpdir(), 'outside.json');
    const result = relativeToWorkspace(outside, tmpDir);
    expect(result).toBe(outside);
  });
});

// ─── Resource state management ───────────────────────────────────────────────

describe('createResourceState / get/applyValueToState / deleteKeyFromState', () => {
  it('flat structure: getValueFromState returns existing value', () => {
    writeLocale('en.json', { greeting: 'Hello' });
    // Mock resource directly
    const resource = {
      filePath: path.join(tmpDir, 'locales', 'en.json'),
      fileName: 'en',
      isNested: false,
      keyValuePairs: { greeting: 'Hello' } as Record<string, string>,
    };
    const state = createResourceState(resource, 'flat', tmpDir);
    expect(getValueFromState(state, 'greeting')).toBe('Hello');
  });

  it('flat structure: applyValueToState changes value', () => {
    const resource = {
      filePath: path.join(tmpDir, 'locales', 'en.json'),
      fileName: 'en',
      isNested: false,
      keyValuePairs: { existing: 'value' } as Record<string, string>,
    };
    writeLocale('en.json', { existing: 'value' });
    const state = createResourceState(resource, 'flat', tmpDir);
    applyValueToState(state, 'newKey', 'newValue');
    expect(getValueFromState(state, 'newKey')).toBe('newValue');
    expect(state.changed).toBe(true);
    expect(state.createdKeys).toContain('newKey');
  });

  it('deleteKeyFromState removes key', () => {
    const resource = {
      filePath: path.join(tmpDir, 'locales', 'en.json'),
      fileName: 'en',
      isNested: false,
      keyValuePairs: { toDelete: 'bye' } as Record<string, string>,
    };
    writeLocale('en.json', { toDelete: 'bye' });
    const state = createResourceState(resource, 'flat', tmpDir);
    const result = deleteKeyFromState(state, 'toDelete');
    expect(result).toBe(true);
    expect(getValueFromState(state, 'toDelete')).toBeUndefined();
    expect(state.changed).toBe(true);
  });

  it('deleteKeyFromState returns false for missing key', () => {
    const resource = {
      filePath: path.join(tmpDir, 'locales', 'en.json'),
      fileName: 'en',
      isNested: false,
      keyValuePairs: {} as Record<string, string>,
    };
    writeLocale('en.json', {});
    const state = createResourceState(resource, 'flat', tmpDir);
    const result = deleteKeyFromState(state, 'ghost');
    expect(result).toBe(false);
    expect(state.changed).toBe(false);
  });

  it('listKeysFromState returns all keys', () => {
    const resource = {
      filePath: path.join(tmpDir, 'locales', 'en.json'),
      fileName: 'en',
      isNested: false,
      keyValuePairs: { a: '1', b: '2' } as Record<string, string>,
    };
    writeLocale('en.json', { a: '1', b: '2' });
    const state = createResourceState(resource, 'flat', tmpDir);
    expect(listKeysFromState(state)).toEqual(expect.arrayContaining(['a', 'b']));
  });
});

// ─── toolCheckKeys ───────────────────────────────────────────────────────────

describe('toolCheckKeys', () => {
  beforeEach(() => {
    writeLocale('en.json', { greeting: 'Hello', farewell: 'Goodbye' });
    writeLocale('fr.json', { greeting: 'Bonjour' });
  });

  it('present key shows true for all locales that have it', async () => {
    const result = await toolCheckKeys({ keys: ['greeting'], workspaceDir: tmpDir });
    // toolCheckKeys uses resource.fileName (without extension) as key
    expect(result['greeting']['en']).toBe(true);
    expect(result['greeting']['fr']).toBe(true);
  });

  it('missing key shows false', async () => {
    const result = await toolCheckKeys({ keys: ['farewell'], workspaceDir: tmpDir });
    expect(result['farewell']['en']).toBe(true);
    expect(result['farewell']['fr']).toBe(false);
  });

  it('namespace prefix with dot matches prefix keys', async () => {
    writeLocale('en.json', { 'nav.home': 'Home', 'nav.about': 'About' });
    const result = await toolCheckKeys({ keys: ['nav.'], workspaceDir: tmpDir });
    expect(result['nav.']['en']).toBe(true);
  });

  it('empty keys array → empty result', async () => {
    const result = await toolCheckKeys({ keys: [], workspaceDir: tmpDir });
    expect(Object.keys(result).length).toBe(0);
  });
});

// ─── toolListLocales ─────────────────────────────────────────────────────────

describe('toolListLocales', () => {
  beforeEach(() => {
    writeLocale('en.json', { a: '1' });
    writeLocale('fr.json', { a: '1' });
  });

  it('returns locale list with expected fields', async () => {
    const res = await toolListLocales({ workspaceDir: tmpDir });
    expect(res.languages).toContain('en');
    expect(res.languages).toContain('fr');
    expect(res.locales.length).toBe(2);
    const enLocale = res.locales.find(l => l.locale === 'en')!;
    expect(enLocale).toBeDefined();
    expect(enLocale.keyCount).toBe(1);
  });
});

// ─── Low-context tools ───────────────────────────────────────────────────────

describe('low-context project/read tools', () => {
  beforeEach(() => {
    writeLocale('en.json', {
      'nav.home': 'Home',
      'nav.about': 'About',
      'unused.key': 'Unused',
      long: 'x'.repeat(80),
      msg: 'Hello {{name}}',
    });
    writeLocale('tr.json', {
      'nav.home': 'Ana Sayfa',
      long: 'y'.repeat(80),
      msg: 'Merhaba {{isim}}',
    });
    writeSource('src/App.tsx', `
      const a = t("nav.home");
      const b = t("missing.in.locales");
    `);
  });

  it('toolProjectInfo returns compact counts and config', async () => {
    const res = await toolProjectInfo({ workspaceDir: tmpDir });
    expect(res.totals.localeCount).toBe(2);
    expect(res.totals.uniqueKeyCount).toBeGreaterThanOrEqual(5);
    expect(res.config.resourceGlob).toContain('locales');
  });

  it('toolSearchKeys supports prefix search with value preview limits', async () => {
    const res = await toolSearchKeys({
      keyPrefix: 'nav.',
      includeValues: true,
      maxValueChars: 4,
      workspaceDir: tmpDir,
    });
    expect(res.totalMatches).toBe(2);
    expect(res.matches[0].key.startsWith('nav.')).toBe(true);
    expect(res.matches[0].locales[0].valuePreview!.length).toBeLessThanOrEqual(4);
  });

  it('toolGetNamespace returns presence without values by default', async () => {
    const res = await toolGetNamespace({ prefix: 'nav', workspaceDir: tmpDir });
    expect(res.prefix).toBe('nav.');
    expect(res.totalKeys).toBe(2);
    expect(res.keys[0].values).toBeUndefined();
    const about = res.keys.find(k => k.key === 'nav.about')!;
    expect(about.missingLocales).toContain('tr');
  });

  it('toolUnusedKeys returns locale keys not referenced in code', async () => {
    const res = await toolUnusedKeys({ workspaceDir: tmpDir });
    expect(res.unused.some(item => item.key === 'unused.key')).toBe(true);
    expect(res.unused.some(item => item.key === 'nav.home')).toBe(false);
  });

  it('toolAudit summarizes missing, placeholder, code-missing, and unused issues', async () => {
    const res = await toolAudit({ baseLocale: 'en', workspaceDir: tmpDir });
    expect(res.summary.missingAgainstBase).toBeGreaterThan(0);
    expect(res.summary.placeholderMismatches).toBeGreaterThan(0);
    expect(res.summary.codeMissingKeys).toBeGreaterThan(0);
    expect(res.summary.unusedKeys).toBeGreaterThan(0);
  });

  it('toolUntranslatedKeysOnPage rejects files outside the workspace', async () => {
    const outside = path.join(os.tmpdir(), `outside-${Date.now()}.tsx`);
    try {
      fs.writeFileSync(outside, 'const x = t("nav.home");', 'utf8');
      await expect(toolUntranslatedKeysOnPage({ filePath: outside, workspaceDir: tmpDir })).rejects.toThrow('outside workspace root');
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});

// ─── toolGetTranslations ─────────────────────────────────────────────────────

describe('toolGetTranslations', () => {
  beforeEach(() => {
    writeLocale('en.json', { greeting: 'Hello', farewell: 'Goodbye' });
    writeLocale('fr.json', { greeting: 'Bonjour' });
  });

  it('returns translations for known key', async () => {
    const res = await toolGetTranslations({ keys: ['greeting'], workspaceDir: tmpDir });
    expect(res.translations[0].key).toBe('greeting');
    expect(res.translations[0].values['en']).toBe('Hello');
    expect(res.translations[0].values['fr']).toBe('Bonjour');
  });

  it('missing translation → null', async () => {
    const res = await toolGetTranslations({ keys: ['farewell'], workspaceDir: tmpDir });
    expect(res.translations[0].values['fr']).toBe(null);
  });

  it('throws for empty keys array', async () => {
    await expect(toolGetTranslations({ keys: [], workspaceDir: tmpDir })).rejects.toThrow();
  });
});

// ─── toolUpsertTranslations ──────────────────────────────────────────────────

describe('toolUpsertTranslations', () => {
  beforeEach(() => {
    writeLocale('en.json', { existing: 'Old' });
    writeLocale('fr.json', { existing: 'Vieux' });
  });

  it('creates new key', async () => {
    const res = await toolUpsertTranslations({
      entries: [{ key: 'newKey', values: { en: 'New', fr: 'Nouveau' } }],
      dryRun: false,
      workspaceDir: tmpDir,
    });
    expect(res.summary.created).toBe(2);
    const enContent = JSON.parse(fs.readFileSync(path.join(tmpDir, 'locales', 'en.json'), 'utf8'));
    expect(enContent.newKey).toBe('New');
  });

  it('defaults to dryRun and reports changed files without persisting', async () => {
    const res = await toolUpsertTranslations({
      entries: [{ key: 'previewOnly', values: { en: 'Preview' } }],
      workspaceDir: tmpDir,
    });
    expect(res.dryRun).toBe(true);
    expect(res.changedFiles).toContain(path.join('locales', 'en.json'));
    const enContent = JSON.parse(fs.readFileSync(path.join(tmpDir, 'locales', 'en.json'), 'utf8'));
    expect(enContent.previewOnly).toBeUndefined();
  });

  it('updates existing key', async () => {
    const res = await toolUpsertTranslations({
      entries: [{ key: 'existing', values: { en: 'Updated', fr: 'Mis à jour' } }],
      dryRun: false,
      workspaceDir: tmpDir,
    });
    expect(res.summary.updated).toBe(2);
  });

  it('dryRun does not persist', async () => {
    await toolUpsertTranslations({
      entries: [{ key: 'dryKey', values: { en: 'NotSaved' } }],
      dryRun: true,
      workspaceDir: tmpDir,
    });
    const enContent = JSON.parse(fs.readFileSync(path.join(tmpDir, 'locales', 'en.json'), 'utf8'));
    expect(enContent.dryKey).toBeUndefined();
  });

  it('unchanged key → summary.unchanged incremented', async () => {
    const res = await toolUpsertTranslations({
      entries: [{ key: 'existing', values: { en: 'Old' } }],
      dryRun: false,
      workspaceDir: tmpDir,
    });
    expect(res.summary.unchanged).toBeGreaterThanOrEqual(1);
  });

  it('throws for empty entries', async () => {
    await expect(toolUpsertTranslations({ entries: [], workspaceDir: tmpDir })).rejects.toThrow();
  });
});

// ─── toolDeleteKey ───────────────────────────────────────────────────────────

describe('toolDeleteKey', () => {
  beforeEach(() => {
    writeLocale('en.json', { toRemove: 'bye', keep: 'yes' });
    writeLocale('fr.json', { toRemove: 'au revoir', keep: 'oui' });
  });

  it('deletes key from all locales', async () => {
    const res = await toolDeleteKey({ key: 'toRemove', dryRun: false, workspaceDir: tmpDir });
    expect(res.deletedFrom.length).toBe(2);
    const enContent = JSON.parse(fs.readFileSync(path.join(tmpDir, 'locales', 'en.json'), 'utf8'));
    expect(enContent.toRemove).toBeUndefined();
  });

  it('dryRun does not persist deletion', async () => {
    await toolDeleteKey({ key: 'toRemove', dryRun: true, workspaceDir: tmpDir });
    const enContent = JSON.parse(fs.readFileSync(path.join(tmpDir, 'locales', 'en.json'), 'utf8'));
    expect(enContent.toRemove).toBe('bye');
  });

  it('non-existent key → deletedFrom empty', async () => {
    const res = await toolDeleteKey({ key: 'ghost', workspaceDir: tmpDir });
    expect(res.deletedFrom.length).toBe(0);
  });
});

// ─── toolDiffLocales ─────────────────────────────────────────────────────────

describe('toolDiffLocales', () => {
  beforeEach(() => {
    writeLocale('en.json', { a: '1', b: '2', c: '{{name}} is here' });
    writeLocale('fr.json', { a: 'un', c: '{nom} est là' });
  });

  it('detects missing key in fr', async () => {
    const res = await toolDiffLocales({ base: 'en', compare: ['fr'], workspaceDir: tmpDir });
    const frComp = res.comparisons[0];
    expect(frComp.locale).toBe('fr');
    expect(frComp.missing).toContain('b');
  });

  it('detects placeholder mismatch', async () => {
    const res = await toolDiffLocales({ base: 'en', compare: ['fr'], workspaceDir: tmpDir });
    const frComp = res.comparisons[0];
    // en has {{name}}, fr has {nom} — mismatched placeholder names
    const mismatch = frComp.placeholderMismatches.find(m => m.key === 'c');
    expect(mismatch).toBeDefined();
  });

  it('throws for unknown base locale', async () => {
    await expect(toolDiffLocales({ base: 'de', compare: ['fr'], workspaceDir: tmpDir })).rejects.toThrow();
  });
});

// ─── toolRenameKey ───────────────────────────────────────────────────────────

describe('toolRenameKey', () => {
  beforeEach(() => {
    writeLocale('en.json', { oldKey: 'Hello', other: 'World' });
    writeLocale('fr.json', { oldKey: 'Bonjour', other: 'Monde' });
  });

  it('renames key across all locales', async () => {
    const res = await toolRenameKey({ from: 'oldKey', to: 'newKey', dryRun: false, workspaceDir: tmpDir });
    expect(res.summary.renamed).toBe(2);
    const enContent = JSON.parse(fs.readFileSync(path.join(tmpDir, 'locales', 'en.json'), 'utf8'));
    expect(enContent.newKey).toBe('Hello');
    expect(enContent.oldKey).toBeUndefined();
  });

  it('dryRun does not persist', async () => {
    await toolRenameKey({ from: 'oldKey', to: 'newKey', dryRun: true, workspaceDir: tmpDir });
    const enContent = JSON.parse(fs.readFileSync(path.join(tmpDir, 'locales', 'en.json'), 'utf8'));
    expect(enContent.oldKey).toBe('Hello');
  });

  it('throws when from equals to', async () => {
    await expect(toolRenameKey({ from: 'oldKey', to: 'oldKey', workspaceDir: tmpDir })).rejects.toThrow();
  });
});

// ─── toolMoveNamespace ───────────────────────────────────────────────────────

describe('toolMoveNamespace', () => {
  beforeEach(() => {
    writeLocale('en.json', { 'nav.home': 'Home', 'nav.about': 'About', 'other': 'X' });
    writeLocale('fr.json', { 'nav.home': 'Accueil', 'nav.about': 'À propos' });
  });

  it('moves namespace keys', async () => {
    const res = await toolMoveNamespace({ from: 'nav', to: 'menu', dryRun: false, workspaceDir: tmpDir });
    expect(res.summary.moved).toBeGreaterThan(0);
    const enContent = JSON.parse(fs.readFileSync(path.join(tmpDir, 'locales', 'en.json'), 'utf8'));
    expect(enContent['menu.home']).toBe('Home');
    expect(enContent['nav.home']).toBeUndefined();
  });

  it('dryRun preserves original', async () => {
    await toolMoveNamespace({ from: 'nav', to: 'menu', dryRun: true, workspaceDir: tmpDir });
    const enContent = JSON.parse(fs.readFileSync(path.join(tmpDir, 'locales', 'en.json'), 'utf8'));
    expect(enContent['nav.home']).toBe('Home');
  });

  it('locale with no matching prefix → skipped', async () => {
    writeLocale('de.json', { 'other.key': 'Wert' });
    const res = await toolMoveNamespace({ from: 'nav', to: 'menu', dryRun: false, workspaceDir: tmpDir });
    const deResult = res.results.find(r => r.locale === 'de');
    if (deResult) expect(deResult.result).toBe('skipped');
  });
});

// ─── toolValidatePlaceholders ────────────────────────────────────────────────

describe('toolValidatePlaceholders', () => {
  beforeEach(() => {
    writeLocale('en.json', { msg: 'Hello {{name}}, you have {count} items' });
    writeLocale('fr.json', { msg: 'Bonjour {{name}}, vous avez {total} éléments' });
  });

  it('detects placeholder mismatch in fr vs en', async () => {
    const res = await toolValidatePlaceholders({ baseLocale: 'en', workspaceDir: tmpDir });
    const mismatch = res.mismatches.find(m => m.key === 'msg' && m.locale === 'fr');
    expect(mismatch).toBeDefined();
    expect(mismatch!.missing).toContain('count');
    expect(mismatch!.extra).toContain('total');
  });

  it('no mismatches when placeholders match', async () => {
    writeLocale('de.json', { msg: 'Hallo {{name}}, Sie haben {count} Artikel' });
    const res = await toolValidatePlaceholders({ baseLocale: 'en', locales: ['en', 'de'], workspaceDir: tmpDir });
    expect(res.mismatches.length).toBe(0);
  });
});

// ─── toolFormatResources ─────────────────────────────────────────────────────

describe('toolFormatResources', () => {
  beforeEach(() => {
    const localeDir = makeLocaleDir();
    fs.writeFileSync(path.join(localeDir, 'en.json'), '{"z":"last","a":"first"}', 'utf8');
  });

  it('defaults to dryRun and does not persist formatting', async () => {
    const res = await toolFormatResources({ workspaceDir: tmpDir });
    expect(res.dryRun).toBe(true);
    expect(res.summary.changed).toBe(1);
    expect(fs.readFileSync(path.join(tmpDir, 'locales', 'en.json'), 'utf8')).toBe('{"z":"last","a":"first"}');
  });

  it('applies formatting and sorted keys when dryRun is false', async () => {
    const res = await toolFormatResources({ dryRun: false, workspaceDir: tmpDir });
    expect(res.dryRun).toBe(false);
    const raw = fs.readFileSync(path.join(tmpDir, 'locales', 'en.json'), 'utf8');
    expect(raw.indexOf('"a"')).toBeLessThan(raw.indexOf('"z"'));
    expect(raw.endsWith('\n')).toBe(true);
  });
});
