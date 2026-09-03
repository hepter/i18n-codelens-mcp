import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadProject, clearResourceCache } from '../core/resources';
import { createResourceManager } from '../core/resource-manager';
import { getEffectiveConfigFromEnv } from '../config';
import { flattenObject } from '../resource-utils';

let root: string;

beforeEach(() => {
  clearResourceCache();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-mgr-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const write = (rel: string, doc: unknown): string => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(doc, null, 2) + '\n');
  return abs;
};
const read = (abs: string): Record<string, unknown> => JSON.parse(fs.readFileSync(abs, 'utf8'));
const manager = async (env: NodeJS.ProcessEnv = {}) => createResourceManager(await loadProject(root, getEffectiveConfigFromEnv(env)));

/** Mixed file shaped like the one destroyed in the 2026-09-03 incident. */
function buildMixedLocale(flatKeyCount: number): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  for (let i = 0; i < flatKeyCount; i++) {
    doc[`component.group${String(Math.floor(i / 10)).padStart(2, '0')}.key${String(i).padStart(3, '0')}`] = `Value ${i}`;
  }
  doc['dashboard.announcement'] = 'Announcement';
  for (let i = 0; i < 5; i++) doc[`dashboard.announcement.field${i}`] = `Field ${i}`;
  for (let i = 0; i < 3; i++) doc[`campaign.status.label${i}`] = `Label ${i}`;
  doc['campaign.status'] = 'Status';
  doc.settings = { profile: { title: 'Profile', subtitle: 'Your profile' } };
  doc.errors = { notFound: 'Not found' };
  return doc;
}

describe('flat file', () => {
  it('reads values and reports the absence of a key', async () => {
    write('locales/en.json', { 'nav.home': 'Home', 'nav.about': 'About' });
    const m = await manager();
    expect(m.get('en', 'nav.home')).toBe('Home');
    expect(m.get('en', 'nav.contact')).toBeUndefined();
    expect(m.get('xx', 'nav.home')).toBeUndefined();
  });

  it('adds a key next to its closest neighbour and writes only when committed', async () => {
    const file = write('locales/en.json', { 'nav.home': 'Home', 'btn.save': 'Save', 'nav.about': 'About' });
    const m = await manager();
    m.set('en', 'nav.contact', 'Contact');
    expect(m.changedFiles()).toEqual(['locales/en.json']);
    expect(m.commit(true)).toEqual(['locales/en.json']);
    expect(Object.keys(read(file))).toEqual(['nav.home', 'btn.save', 'nav.about']);
    expect(m.commit(false)).toEqual(['locales/en.json']);
    // "nearby" inserts right after the closest existing key rather than at the end.
    expect(Object.keys(read(file))).toEqual(['nav.home', 'nav.contact', 'btn.save', 'nav.about']);
  });

  it('append strategy puts new keys at the end and sort strategy sorts everything', async () => {
    const file = write('locales/en.json', { b: '1', a: '2' });
    const m1 = await manager({ I18N_INSERT_ORDER: 'append' });
    m1.set('en', 'aa', '3');
    m1.commit(false);
    expect(Object.keys(read(file))).toEqual(['b', 'a', 'aa']);
    clearResourceCache();
    const m2 = await manager({ I18N_INSERT_ORDER: 'sort' });
    m2.set('en', 'c', '4');
    m2.commit(false);
    expect(Object.keys(read(file))).toEqual(['a', 'aa', 'b', 'c']);
  });

  it('deletes exactly the requested key', async () => {
    const file = write('locales/en.json', { a: '1', b: '2' });
    const m = await manager();
    expect(m.delete('en', 'b')).toBe(true);
    expect(m.delete('en', 'zzz')).toBe(false);
    m.commit(false);
    expect(read(file)).toEqual({ a: '1' });
  });

  it('updates a value in place without reordering', async () => {
    const file = write('locales/en.json', { a: '1', b: '2', c: '3' });
    const m = await manager();
    m.set('en', 'b', 'two');
    m.commit(false);
    expect(read(file)).toEqual({ a: '1', b: 'two', c: '3' });
  });
});

describe('nested file', () => {
  it('reads dotted keys and adds a new leaf inside the existing object', async () => {
    const file = write('locales/en.json', { nav: { home: 'Home' }, msg: { hi: 'Hi' } });
    const m = await manager();
    expect(m.get('en', 'nav.home')).toBe('Home');
    m.set('en', 'nav.about', 'About');
    m.commit(false);
    expect(read(file)).toEqual({ nav: { home: 'Home', about: 'About' }, msg: { hi: 'Hi' } });
  });

  it('deletes a nested leaf and keeps its siblings', async () => {
    const file = write('locales/en.json', { nav: { home: 'Home', about: 'About' } });
    const m = await manager();
    expect(m.delete('en', 'nav.home')).toBe(true);
    m.commit(false);
    expect(read(file)).toEqual({ nav: { about: 'About' } });
  });

  it('refuses to turn a namespace into a value', async () => {
    write('locales/en.json', { nav: { home: 'Home' } });
    const m = await manager();
    expect(() => m.set('en', 'nav', 'oops')).toThrow(/namespace/);
  });
});

describe('mixed file is edited in place, never converted', () => {
  it('adds a flat key as a single literal property and loses nothing', async () => {
    const file = write('locales/en.json', buildMixedLocale(40));
    const before = flattenObject(read(file));
    const m = await manager();
    m.set('en', 'component.group00.brandNew', 'Brand new');
    m.commit(false);
    const doc = read(file);
    const after = flattenObject(doc);
    expect(Object.keys(before).filter(k => !(k in after))).toEqual([]);
    expect(doc['component.group00.brandNew']).toBe('Brand new');
    expect(typeof doc['component.group00.key000']).toBe('string');
    expect((doc.settings as Record<string, unknown>).profile).toEqual({ title: 'Profile', subtitle: 'Your profile' });
  });

  it('adds a child under a name that is also a value without touching the value', async () => {
    const file = write('locales/en.json', buildMixedLocale(10));
    const m = await manager();
    m.set('en', 'dashboard.announcement.campaignStatus', 'Campaign status');
    m.commit(false);
    const doc = read(file);
    expect(doc['dashboard.announcement']).toBe('Announcement');
    expect(doc['dashboard.announcement.campaignStatus']).toBe('Campaign status');
  });

  it('updates a nested island leaf where it lives', async () => {
    const file = write('locales/en.json', buildMixedLocale(10));
    const m = await manager();
    m.set('en', 'settings.profile.title', 'Profile page');
    m.commit(false);
    const doc = read(file) as { settings: { profile: { title: string; subtitle: string } } };
    expect(doc.settings.profile).toEqual({ title: 'Profile page', subtitle: 'Your profile' });
  });

  it('deletes exactly one key from a colliding pair', async () => {
    const file = write('locales/en.json', buildMixedLocale(10));
    const before = Object.keys(flattenObject(read(file)));
    const m = await manager();
    expect(m.delete('en', 'campaign.status')).toBe(true);
    m.commit(false);
    const after = Object.keys(flattenObject(read(file)));
    expect(before.filter(k => !after.includes(k))).toEqual(['campaign.status']);
    expect(after).toContain('campaign.status.label0');
  });

  it('places a new key nested when the file is nested-dominant, or flat when the path is blocked', async () => {
    const file = write('locales/en.json', { nav: { home: 'Home', about: 'About' }, msg: { welcome: 'Welcome', bye: 'Bye' }, 'legacy.key': 'Legacy', legacy: 'Legacy root' });
    const m = await manager();
    m.set('en', 'nav.contact', 'Contact');
    m.set('en', 'legacy.other', 'Other');
    m.commit(false);
    const doc = read(file);
    expect((doc.nav as Record<string, unknown>).contact).toBe('Contact');
    expect(doc.legacy).toBe('Legacy root');
    expect(doc['legacy.other']).toBe('Other');
    expect(doc['legacy.key']).toBe('Legacy');
  });
});

describe('forced structure and the write guard', () => {
  it('I18N_STRUCTURE=nested refuses a colliding file and leaves it intact', async () => {
    const file = write('locales/en.json', buildMixedLocale(10));
    const before = read(file);
    const m = await manager({ I18N_STRUCTURE: 'nested' });
    m.set('en', 'component.group00.brandNew', 'Brand new');
    expect(() => m.commit(false)).toThrow(/value and also the parent|both a value and a namespace/);
    expect(read(file)).toEqual(before);
  });

  it('I18N_STRUCTURE=flat converts a nested file to dotted keys without losing any', async () => {
    const file = write('locales/en.json', { nav: { home: 'Home' } });
    const m = await manager({ I18N_STRUCTURE: 'flat' });
    m.set('en', 'nav.about', 'About');
    m.commit(false);
    expect(read(file)).toEqual({ 'nav.home': 'Home', 'nav.about': 'About' });
  });

  it('a corrupted state cannot drop keys: the guard aborts the write', async () => {
    const file = write('locales/en.json', { a: '1', b: '2' });
    const m = await manager();
    const state = m.stateFor('en', '')!;
    state.flatMap = { a: '1' };
    state.changed = true;
    expect(() => m.commit(false)).toThrow(/missing 1 existing key/);
    expect(read(file)).toEqual({ a: '1', b: '2' });
  });
});

describe('namespaced project', () => {
  beforeEach(() => {
    write('locales/en/common.json', { nav: { home: 'Home' } });
    write('locales/en/auth.json', { login: { title: 'Log in' } });
    write('locales/tr/common.json', { nav: { home: 'Ana Sayfa' } });
    write('locales/tr/auth.json', { login: { title: 'Giriş' } });
  });

  it('routes keys to the namespace file and returns namespaced file paths', async () => {
    const m = await manager();
    expect(m.get('en', 'auth:login.title')).toBe('Log in');
    m.set('en', 'auth:login.forgot', 'Forgot?');
    m.set('tr', 'common:nav.about', 'Hakkında');
    expect(m.commit(false).sort()).toEqual(['locales/en/auth.json', 'locales/tr/common.json']);
    expect(read(path.join(root, 'locales/en/auth.json'))).toEqual({ login: { title: 'Log in', forgot: 'Forgot?' } });
    expect(read(path.join(root, 'locales/tr/common.json'))).toEqual({ nav: { home: 'Ana Sayfa', about: 'Hakkında' } });
  });

  it('lists full keys with their namespace prefix', async () => {
    const m = await manager();
    expect(m.listKeys('en').sort()).toEqual(['auth:login.title', 'common:nav.home']);
  });

  it('rejects an unknown namespace before touching anything', async () => {
    const m = await manager();
    expect(() => m.set('en', 'shop:cart', 'Cart')).toThrow(/Unknown namespace/);
    expect(m.changedFiles()).toEqual([]);
  });
});
