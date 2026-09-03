import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadProject, clearResourceCache } from '../core/resources';
import { getEffectiveConfigFromEnv } from '../config';

const FIXTURES = path.resolve(__dirname, '..', '..', 'fixtures');
const cfg = (env: NodeJS.ProcessEnv = {}) => getEffectiveConfigFromEnv(env);

beforeEach(() => clearResourceCache());

describe('loadProject on a flat single-file-per-locale layout', () => {
  const root = path.join(FIXTURES, 'flat-project');

  it('detects both locales, sorted, with posix relative paths', async () => {
    const project = await loadProject(root, cfg());
    expect(project.locales).toEqual(['en', 'tr']);
    expect(project.namespaced).toBe(false);
    expect(project.namespaces).toEqual([]);
    expect(project.warnings).toEqual([]);
    expect(project.resources.map(r => r.relativePath)).toEqual(['locales/en.json', 'locales/tr.json']);
  });

  it('exposes flattened keys and values per locale', async () => {
    const project = await loadProject(root, cfg());
    expect(project.localeKeys('en').size).toBe(11);
    expect(project.localeKeys('tr').size).toBe(7);
    expect(project.getValue('en', 'nav.home')).toBe('Home');
    expect(project.getValue('tr', 'nav.contact')).toBeUndefined();
    expect(project.hasKey('tr', 'greeting')).toBe(true);
  });

  it('lists the union of keys sorted', async () => {
    const project = await loadProject(root, cfg());
    expect(project.allKeys().length).toBe(11);
    expect(project.allKeys()[0]).toBe('btn.cancel');
  });

  it('splitKey is a no-op without namespaces, even with a colon in the key', async () => {
    const project = await loadProject(root, cfg());
    expect(project.splitKey('a:b.c')).toEqual({ namespace: '', key: 'a:b.c' });
    expect(project.fullKey('', 'x')).toBe('x');
  });

  it('reports the structure of each file', async () => {
    const project = await loadProject(root, cfg());
    expect(project.resources[0].structure.kind).toBe('flat');
    const nested = await loadProject(path.join(FIXTURES, 'nested-project'), cfg());
    expect(nested.resources[0].structure.kind).toBe('nested');
    expect(nested.getValue('en', 'auth.login')).toBe('Log in');
  });
});

describe('loadProject on a {locale}/{namespace}.json layout', () => {
  const root = path.join(FIXTURES, 'namespaced-project');

  it('derives the locale from the directory and the namespace from the file', async () => {
    const project = await loadProject(root, cfg());
    expect(project.namespaced).toBe(true);
    expect(project.locales).toEqual(['en', 'tr']);
    expect(project.namespaces).toEqual(['auth', 'common']);
    expect(project.fileFor('en', 'auth')?.relativePath).toBe('locales/en/auth.json');
    expect(project.fileFor('tr', 'common')?.namespace).toBe('common');
  });

  it('prefixes keys with namespace and separator', async () => {
    const project = await loadProject(root, cfg());
    expect(project.getValue('en', 'common:nav.home')).toBe('Home');
    expect(project.getValue('tr', 'auth:login.hint')).toBe('{{eposta}} girin');
    expect(project.getValue('tr', 'common:nav.about')).toBeUndefined();
    expect(project.allKeys()).toEqual(['auth:login.hint', 'auth:login.title', 'common:btn.save', 'common:nav.about', 'common:nav.home']);
  });

  it('splits namespaced keys and rejects unknown or missing namespaces', async () => {
    const project = await loadProject(root, cfg());
    expect(project.splitKey('common:nav.home')).toEqual({ namespace: 'common', key: 'nav.home' });
    expect(() => project.splitKey('shop:cart')).toThrow(/Unknown namespace 'shop'/);
    expect(() => project.splitKey('nav.home')).toThrow(/namespace/);
  });

  it('honours I18N_DEFAULT_NS for keys without a namespace', async () => {
    const project = await loadProject(root, cfg({ I18N_DEFAULT_NS: 'common' }));
    expect(project.splitKey('nav.home')).toEqual({ namespace: 'common', key: 'nav.home' });
  });

  it('honours a custom separator', async () => {
    const project = await loadProject(root, cfg({ I18N_NS_SEPARATOR: '/' }));
    expect(project.getValue('en', 'common/nav.home')).toBe('Home');
    expect(project.fullKey('auth', 'x')).toBe('auth/x');
  });
});

describe('loadProject warnings and caching', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-res-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const write = (rel: string, content: unknown) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
    return abs;
  };

  it('keeps one file per locale when the glob finds duplicates, and warns', async () => {
    write('public/locales/en.json', { a: 'copy' });
    write('src/locales/en.json', { a: 'source' });
    const project = await loadProject(root, cfg());
    expect(project.locales).toEqual(['en']);
    expect(project.warnings.map(w => w.kind)).toEqual(['duplicate']);
    expect(project.warnings[0].files).toHaveLength(2);
    expect(project.warnings[0].message).toContain('I18N_GLOB');
  });

  it('skips files whose name is not a locale and warns', async () => {
    write('locales/en.json', { a: '1' });
    write('locales/config.json', { debug: true });
    const project = await loadProject(root, cfg());
    expect(project.locales).toEqual(['en']);
    expect(project.warnings.map(w => w.kind)).toEqual(['skipped']);
    expect(project.warnings[0].files).toEqual(['locales/config.json']);
  });

  it('skips invalid JSON and warns instead of failing the whole project', async () => {
    write('locales/en.json', { a: '1' });
    write('locales/tr.json', '{ broken');
    const project = await loadProject(root, cfg());
    expect(project.locales).toEqual(['en']);
    expect(project.warnings.map(w => w.kind)).toEqual(['invalid-json']);
  });

  it('returns an empty project when nothing matches', async () => {
    const project = await loadProject(root, cfg());
    expect(project.resources).toEqual([]);
    expect(project.locales).toEqual([]);
  });

  it('reuses the parsed file while it is unchanged and re-reads it after a change', async () => {
    const file = write('locales/en.json', { a: '1' });
    const first = await loadProject(root, cfg());
    const second = await loadProject(root, cfg());
    expect(second.resources[0].keyValuePairs).toBe(first.resources[0].keyValuePairs);

    fs.writeFileSync(file, JSON.stringify({ a: '1', b: '2' }));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(file, future, future);
    const third = await loadProject(root, cfg());
    expect(third.getValue('en', 'b')).toBe('2');
    expect(third.resources[0].keyValuePairs).not.toBe(first.resources[0].keyValuePairs);
  });

  it('ignores files under default ignore globs such as dist', async () => {
    write('locales/en.json', { a: '1' });
    write('dist/locales/en.json', { a: 'built' });
    write('node_modules/pkg/locales/en.json', { a: 'dep' });
    const project = await loadProject(root, cfg());
    expect(project.resources.map(r => r.relativePath)).toEqual(['locales/en.json']);
    expect(project.warnings).toEqual([]);
  });
});
