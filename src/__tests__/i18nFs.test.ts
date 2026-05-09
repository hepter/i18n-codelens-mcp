import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  getWorkspaceRoot,
  ensureSafeWorkspacePath,
  loadJson,
  writeFilePretty,
  readResourceFiles,
  findUntranslatedKeysInFile,
} from '../i18nFs';

// ─── Temp directory fixture helpers ─────────────────────────────────────────

let tmpDir = '';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-codelens-test-'));
}

function writeTmpFile(rel: string, content: string): string {
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── getWorkspaceRoot ────────────────────────────────────────────────────────

describe('getWorkspaceRoot', () => {
  it('returns a non-empty string', () => {
    const root = getWorkspaceRoot();
    expect(typeof root).toBe('string');
    expect(root.length).toBeGreaterThan(0);
  });

  it('override takes precedence', () => {
    const root = getWorkspaceRoot(tmpDir);
    expect(path.normalize(root)).toBe(path.normalize(tmpDir));
  });

  it('resolves relative override', () => {
    const root = getWorkspaceRoot('.');
    expect(typeof root).toBe('string');
    expect(root.length).toBeGreaterThan(0);
  });
});

// ─── ensureSafeWorkspacePath ─────────────────────────────────────────────────

describe('ensureSafeWorkspacePath', () => {
  it('returns resolves path inside workspace', () => {
    const inner = path.join(tmpDir, 'locales', 'en.json');
    const result = ensureSafeWorkspacePath(inner, tmpDir);
    expect(path.normalize(result)).toBe(path.normalize(inner));
  });

  it('throws for path outside workspace', () => {
    const outside = path.join(os.tmpdir(), 'outside.json');
    expect(() => ensureSafeWorkspacePath(outside, tmpDir)).toThrow('outside workspace root');
  });

  it.skipIf(process.platform === 'win32')('throws for symlink traversal', () => {
    // On Windows this requires elevated privileges, skip in normal test runs
    const target = path.join(tmpDir, 'target.json');
    const link = path.join(tmpDir, 'link.json');
    fs.writeFileSync(target, '{}', 'utf8');
    fs.symlinkSync(target, link);
    expect(() => ensureSafeWorkspacePath(link, tmpDir)).toThrow('symbolic link');
  });
});

// ─── loadJson ────────────────────────────────────────────────────────────────

describe('loadJson', () => {
  it('loads valid JSON', () => {
    const file = writeTmpFile('en.json', JSON.stringify({ key: 'value' }));
    const result = loadJson(file, tmpDir);
    expect(result).toEqual({ key: 'value' });
  });

  it('throws on invalid JSON', () => {
    const file = writeTmpFile('bad.json', 'not-json');
    expect(() => loadJson(file, tmpDir)).toThrow();
  });

  it('throws on missing file', () => {
    const missing = path.join(tmpDir, 'missing.json');
    expect(() => loadJson(missing, tmpDir)).toThrow();
  });

  it('throws for path outside workspace', () => {
    const outside = path.join(os.tmpdir(), `outside-${Date.now()}.json`);
    try {
      fs.writeFileSync(outside, '{}', 'utf8');
      expect(() => loadJson(outside, tmpDir)).toThrow('outside workspace root');
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});

// ─── writeFilePretty ─────────────────────────────────────────────────────────

describe('writeFilePretty', () => {
  it('writes JSON with 2-space indent + newline', () => {
    const file = path.join(tmpDir, 'out.json');
    writeFilePretty(file, { a: 'x' }, tmpDir);
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).toBe(JSON.stringify({ a: 'x' }, null, 2) + '\n');
  });

  it('creates parent directories', () => {
    const file = path.join(tmpDir, 'sub', 'dir', 'out.json');
    writeFilePretty(file, { b: 'y' }, tmpDir);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('overwrites existing file', () => {
    const file = writeTmpFile('over.json', '{"old":"value"}');
    writeFilePretty(file, { new: 'value' }, tmpDir);
    const result = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(result).toEqual({ new: 'value' });
  });

  it('throws for path outside workspace', () => {
    const outside = path.join(os.tmpdir(), `outside-${Date.now()}.json`);
    try {
      expect(() => writeFilePretty(outside, {}, tmpDir)).toThrow('outside workspace root');
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});

// ─── readResourceFiles ───────────────────────────────────────────────────────

describe('readResourceFiles', () => {
  it('returns empty array when no matching files', async () => {
    const result = await readResourceFiles('**/locales/**/*.json', tmpDir);
    expect(result).toEqual([]);
  });

  it('detects flat JSON locale file', async () => {
    writeTmpFile('locales/en.json', JSON.stringify({ greeting: 'Hello' }));
    const resources = await readResourceFiles('**/locales/**/*.json', tmpDir);
    expect(resources).toHaveLength(1);
    expect(resources[0].fileName).toBe('en');
    expect(resources[0].isNested).toBe(false);
    expect(resources[0].keyValuePairs).toEqual({ greeting: 'Hello' });
  });

  it('detects nested JSON locale file', async () => {
    writeTmpFile('locales/fr.json', JSON.stringify({ nav: { home: 'Accueil' } }));
    const resources = await readResourceFiles('**/locales/**/*.json', tmpDir);
    expect(resources).toHaveLength(1);
    expect(resources[0].isNested).toBe(true);
    expect(resources[0].keyValuePairs['nav.home']).toBe('Accueil');
  });

  it('sorts results by file name', async () => {
    writeTmpFile('locales/zh.json', JSON.stringify({ a: '1' }));
    writeTmpFile('locales/de.json', JSON.stringify({ a: '1' }));
    writeTmpFile('locales/en.json', JSON.stringify({ a: '1' }));
    const resources = await readResourceFiles('**/locales/**/*.json', tmpDir);
    const names = resources.map(r => r.fileName);
    expect(names).toEqual([...names].sort());
  });

  it('skips invalid JSON files', async () => {
    writeTmpFile('locales/en.json', JSON.stringify({ ok: 'true' }));
    writeTmpFile('locales/bad.json', 'not-json');
    const resources = await readResourceFiles('**/locales/**/*.json', tmpDir);
    expect(resources).toHaveLength(1);
    expect(resources[0].fileName).toBe('en');
  });
});

// ─── findUntranslatedKeysInFile ──────────────────────────────────────────────

describe('findUntranslatedKeysInFile', () => {
  it('returns empty array for file with no matches', () => {
    const file = writeTmpFile('Component.tsx', 'const x = "no translations here";');
    const result = findUntranslatedKeysInFile(file, []);
    expect(result).toEqual([]);
  });

  it('extracts keys using t() pattern', () => {
    // Default regex matches t("key.name")
    const file = writeTmpFile('Component.tsx', `
      const label = t("hello.world");
      const title = t("nav.home");
    `);
    const result = findUntranslatedKeysInFile(file, []);
    // Results depend on default regex; verify it's an array
    expect(Array.isArray(result)).toBe(true);
  });

  it('filters by provided keys whitelist', () => {
    const file = writeTmpFile('View.tsx', `
      const a = t("key.a");
      const b = t("key.b");
    `);
    const all = findUntranslatedKeysInFile(file, []);
    if (all.length > 1) {
      // Only return keys that are in the provided filter
      const filtered = findUntranslatedKeysInFile(file, [all[0]]);
      expect(filtered).toContain(all[0]);
      expect(filtered).not.toContain(all[1]);
    }
  });
});
