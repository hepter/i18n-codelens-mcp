import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CodeIndex, getCodeIndex, clearCodeIndexCache, keysInFile } from '../core/code-index';
import { getEffectiveConfigFromEnv } from '../config';

const FIXTURES = path.resolve(__dirname, '..', '..', 'fixtures');
const cfg = (env: NodeJS.ProcessEnv = {}) => getEffectiveConfigFromEnv(env);

beforeEach(() => clearCodeIndexCache());

describe('CodeIndex on the flat fixture', () => {
  const root = path.join(FIXTURES, 'flat-project');

  it('collects every key referenced in code', async () => {
    const index = new CodeIndex(root, cfg());
    await index.refresh();
    const keys = index.allKeys();
    expect(keys.has('greeting')).toBe(true);
    expect(keys.has('nav.contact')).toBe(true);
    expect(keys.has('missing.key')).toBe(true);
  });

  it('returns references as workspace-relative posix paths with 1-based line and column', async () => {
    const index = new CodeIndex(root, cfg());
    await index.refresh();
    const refs = index.references(['greeting', 'nope.key']);
    expect(refs['greeting'].total).toBe(1);
    expect(refs['greeting'].references[0]).toEqual({ filePath: 'src/main.ts', line: 4, column: 21 });
    expect(refs['nope.key']).toEqual({ total: 0, references: [] });
  });

  it('caps references per key but keeps the true total', async () => {
    const index = new CodeIndex(root, cfg());
    await index.refresh();
    const refs = index.references(['greeting'], 0);
    expect(refs['greeting'].total).toBe(1);
    expect(refs['greeting'].references).toEqual([]);
  });

  it('scans each file once and reuses it while unchanged', async () => {
    const index = new CodeIndex(root, cfg());
    const first = await index.refresh();
    const second = await index.refresh();
    expect(first.scanned).toBeGreaterThan(0);
    expect(second.scanned).toBe(0);
    expect(second.reused).toBe(first.files);
  });
});

describe('CodeIndex on the namespaced fixture', () => {
  it('keeps the namespace prefix in the key', async () => {
    const index = new CodeIndex(path.join(FIXTURES, 'namespaced-project'), cfg());
    await index.refresh();
    expect(index.allKeys().has('common:nav.home')).toBe(true);
    expect(index.allKeys().has('auth:login.forgot')).toBe(true);
  });
});

describe('CodeIndex cache invalidation', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-code-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rescans a changed file and forgets a deleted one', async () => {
    const a = path.join(root, 'src', 'a.ts');
    const b = path.join(root, 'src', 'b.ts');
    fs.writeFileSync(a, 'const x = t("a.one");');
    fs.writeFileSync(b, 'const y = t("b.one");');
    const index = new CodeIndex(root, cfg());
    await index.refresh();
    expect(Array.from(index.allKeys()).sort()).toEqual(['a.one', 'b.one']);

    fs.writeFileSync(a, 'const x = t("a.two");');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(a, future, future);
    fs.unlinkSync(b);
    const stats = await index.refresh();
    expect(stats.scanned).toBe(1);
    expect(Array.from(index.allKeys()).sort()).toEqual(['a.two']);
  });

  it('respects .gitignore and default ignore globs', async () => {
    fs.writeFileSync(path.join(root, '.gitignore'), 'generated/\n');
    fs.mkdirSync(path.join(root, 'generated'));
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 't("keep.me")');
    fs.writeFileSync(path.join(root, 'generated', 'g.ts'), 't("drop.gitignored")');
    fs.writeFileSync(path.join(root, 'dist', 'd.js'), 't("drop.dist")');
    const index = new CodeIndex(root, cfg());
    await index.refresh();
    expect(Array.from(index.allKeys())).toEqual(['keep.me']);
  });

  it('getCodeIndex returns one shared index per root and config', () => {
    const one = getCodeIndex(root, cfg());
    const two = getCodeIndex(root, cfg());
    const other = getCodeIndex(root, cfg({ I18N_CODE_GLOB: '**/*.vue' }));
    expect(two).toBe(one);
    expect(other).not.toBe(one);
  });
});

describe('keysInFile', () => {
  it('extracts the keys used in one file in order of appearance', () => {
    const file = path.join(FIXTURES, 'nested-project', 'src', 'main.jsx');
    const keys = keysInFile(file, cfg().codeRegex);
    expect(keys.slice(0, 3)).toEqual(['nav.home', 'nav.about', 'nav.contact']);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
