import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createToolContext, type ToolContext } from '../tools/shared';
import { toolUpsertTranslations } from '../tools/upsert-translations';
import { toolDeleteKeys } from '../tools/delete-keys';
import { toolRenameKey } from '../tools/rename-key';
import { toolFormatResources } from '../tools/format-resources';
import { clearResourceCache } from '../core/resources';
import { flattenObject } from '../resource-utils';

const FIXTURES = path.resolve(__dirname, '..', '..', 'fixtures');
let root: string;

beforeEach(() => {
  clearResourceCache();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-write-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const copyFixture = (name: string): ToolContext => {
  fs.cpSync(path.join(FIXTURES, name), root, { recursive: true });
  return createToolContext({ workspaceRoot: root, env: {} });
};
const ctxFor = (env: NodeJS.ProcessEnv = {}) => createToolContext({ workspaceRoot: root, env });
const read = (rel: string): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const raw = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
const writeDoc = (rel: string, doc: unknown) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(doc, null, 2) + '\n');
};

/** Changed region of a line diff: what the write actually touched. */
function diffRegion(before: string, after: string): { added: number; removed: number; addedLines: string[] } {
  const a = before.split('\n');
  const b = after.split('\n');
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return { removed: a.length - prefix - suffix, added: b.length - prefix - suffix, addedLines: b.slice(prefix, b.length - suffix) };
}

function buildMixedLocale(flatKeyCount: number): Record<string, unknown> {
  const doc: Record<string, unknown> = {};
  for (let i = 0; i < flatKeyCount; i++) {
    doc[`component.group${String(Math.floor(i / 40)).padStart(3, '0')}.key${String(i).padStart(4, '0')}`] = `Value ${i}`;
  }
  doc['dashboard.announcement'] = 'Announcement';
  for (let i = 0; i < 58; i++) doc[`dashboard.announcement.field${String(i).padStart(2, '0')}`] = `Announcement field ${i}`;
  for (let i = 0; i < 24; i++) doc[`campaign.status.label${String(i).padStart(2, '0')}`] = `Status label ${i}`;
  doc['campaign.status'] = 'Status';
  doc.settings = { profile: { title: 'Profile', subtitle: 'Your profile' } };
  doc.errors = { notFound: 'Not found', forbidden: 'Forbidden' };
  doc.wizard = { steps: { first: 'First', last: 'Last' } };
  return doc;
}

// ─── upsert ──────────────────────────────────────────────────────────────────

describe('i18n_upsert_translations', () => {
  it('creates keys in every locale and writes immediately', async () => {
    const ctx = copyFixture('flat-project');
    const out = await toolUpsertTranslations({ entries: [{ key: 'new.key', values: { en: 'New', tr: 'Yeni' } }] }, ctx);
    expect(out.applied).toBe(true);
    expect(out.files).toEqual(['locales/en.json', 'locales/tr.json']);
    expect(out.summary).toEqual({ created: 2, updated: 0, unchanged: 0, conflicts: 0 });
    expect(out.created).toEqual({ 'new.key': ['en', 'tr'] });
    expect(read('locales/en.json')['new.key']).toBe('New');
    expect(read('locales/tr.json')['new.key']).toBe('Yeni');
    expect(out).not.toHaveProperty('warnings');
  });

  it('reports a conflict instead of overwriting an existing value', async () => {
    const ctx = copyFixture('flat-project');
    const out = await toolUpsertTranslations({ entries: [{ key: 'greeting', values: { en: 'Hi', tr: 'Merhaba' } }] }, ctx);
    expect(out.applied).toBe(false);
    expect(out.summary).toEqual({ created: 0, updated: 0, unchanged: 1, conflicts: 1 });
    expect(out.conflicts).toEqual({ greeting: { en: { current: 'Hello', proposed: 'Hi' } } });
    expect(out.unchanged).toEqual({ greeting: ['tr'] });
    expect(read('locales/en.json').greeting).toBe('Hello');
  });

  it('overwrites when asked and reports before/after', async () => {
    const ctx = copyFixture('flat-project');
    const out = await toolUpsertTranslations({ entries: [{ key: 'greeting', values: { en: 'Hi', tr: 'Merhaba' } }], overwrite: true }, ctx);
    expect(out.applied).toBe(true);
    expect(out.updated).toEqual({ greeting: { en: { before: 'Hello', after: 'Hi' } } });
    expect(read('locales/en.json').greeting).toBe('Hi');
  });

  it('previews without writing when dryRun is true', async () => {
    const ctx = copyFixture('flat-project');
    const out = await toolUpsertTranslations({ entries: [{ key: 'new.key', values: { en: 'New', tr: 'Yeni' } }], dryRun: true }, ctx);
    expect(out.applied).toBe(false);
    expect(out.dryRun).toBe(true);
    expect(out.files).toEqual(['locales/en.json', 'locales/tr.json']);
    expect(read('locales/en.json')).not.toHaveProperty('new.key');
  });

  it('rejects the whole batch on an unknown locale and writes nothing', async () => {
    const ctx = copyFixture('flat-project');
    await expect(
      toolUpsertTranslations({ entries: [{ key: 'a.b', values: { en: 'A' } }, { key: 'c.d', values: { en: 'C', xx: 'X' } }] }, ctx)
    ).rejects.toThrow(/entries\[1\].*unknown locale 'xx'.*Available locales: en, tr/s);
    expect(read('locales/en.json')).not.toHaveProperty('a.b');
  });

  it('rejects blank keys and empty batches', async () => {
    const ctx = copyFixture('flat-project');
    await expect(toolUpsertTranslations({ entries: [] }, ctx)).rejects.toThrow(/at least one/);
    await expect(toolUpsertTranslations({ entries: [{ key: '  ', values: { en: 'x' } }] }, ctx)).rejects.toThrow(/entries\[0\].*key/);
  });

  it('warns when a locale received no value', async () => {
    const ctx = copyFixture('flat-project');
    const out = await toolUpsertTranslations({ entries: [{ key: 'new.key', values: { en: 'New' } }] }, ctx);
    expect(out.warnings).toEqual(['new.key: no value for tr']);
    expect(out.files).toEqual(['locales/en.json']);
  });

  it('flags placeholder mismatches between the written values, but still writes', async () => {
    const ctx = copyFixture('flat-project');
    const out = await toolUpsertTranslations({ entries: [{ key: 'msg.hi', values: { en: 'Hi {{name}}', tr: 'Selam {{isim}}' } }] }, ctx);
    expect(out.placeholders).toEqual([{ key: 'msg.hi', locale: 'tr', missing: ['name'], extra: ['isim'] }]);
    expect(read('locales/tr.json')['msg.hi']).toBe('Selam {{isim}}');
  });

  it('checks placeholders against the values other locales already hold', async () => {
    const ctx = copyFixture('flat-project');
    const out = await toolUpsertTranslations({ entries: [{ key: 'msg.count', values: { en: 'You have {count} items' } }], overwrite: true }, ctx);
    expect(out.placeholders).toEqual([{ key: 'msg.count', locale: 'tr', missing: ['count'], extra: ['adet'] }]);
  });

  it('writes into the namespace file of a {locale}/{ns}.json project', async () => {
    const ctx = copyFixture('namespaced-project');
    const out = await toolUpsertTranslations({ entries: [{ key: 'auth:login.forgot', values: { en: 'Forgot?', tr: 'Unuttun mu?' } }] }, ctx);
    expect(out.files).toEqual(['locales/en/auth.json', 'locales/tr/auth.json']);
    expect((read('locales/en/auth.json').login as Record<string, string>).forgot).toBe('Forgot?');
    await expect(toolUpsertTranslations({ entries: [{ key: 'shop:cart', values: { en: 'x', tr: 'y' } }] }, ctx)).rejects.toThrow(/Unknown namespace/);
  });

  it('accepts locale aliases such as en_US for en-US and tr.json for tr', async () => {
    const ctx = copyFixture('flat-project');
    const out = await toolUpsertTranslations({ entries: [{ key: 'alias.key', values: { EN: 'A', 'tr.json': 'B' } }] }, ctx);
    expect(out.created).toEqual({ 'alias.key': ['en', 'tr'] });
  });
});

// ─── key-loss regression: the 2026-09-03 incident ────────────────────────────

describe('upsert on a mixed locale file never loses or converts a key', () => {
  beforeEach(() => writeDoc('locales/en.json', buildMixedLocale(3000)));

  it('adds a brand new key as one line and keeps every existing key', async () => {
    const rawBefore = raw('locales/en.json');
    const before = flattenObject(JSON.parse(rawBefore));
    await toolUpsertTranslations({ entries: [{ key: 'component.group000.brandNewKey', values: { en: 'Brand new' } }] }, ctxFor());
    const rawAfter = raw('locales/en.json');
    const after = flattenObject(JSON.parse(rawAfter));
    expect(Object.keys(before).filter(k => !(k in after))).toEqual([]);
    expect(after['dashboard.announcement']).toBe('Announcement');
    expect(after['dashboard.announcement.field00']).toBe('Announcement field 0');
    expect(after['campaign.status']).toBe('Status');
    expect(after['component.group000.brandNewKey']).toBe('Brand new');
    const region = diffRegion(rawBefore, rawAfter);
    expect(region.removed).toBe(0);
    expect(region.added).toBe(1);
    expect(region.addedLines[0]).toContain('component.group000.brandNewKey');
    const doc = JSON.parse(rawAfter) as Record<string, unknown>;
    expect((doc.settings as Record<string, unknown>).profile).toEqual({ title: 'Profile', subtitle: 'Your profile' });
  });

  it('adds a child under a name that is also a value, one line, leaf untouched', async () => {
    const rawBefore = raw('locales/en.json');
    await toolUpsertTranslations({ entries: [{ key: 'dashboard.announcement.campaignStatus', values: { en: 'Campaign status' } }] }, ctxFor());
    const rawAfter = raw('locales/en.json');
    const after = flattenObject(JSON.parse(rawAfter));
    expect(after['dashboard.announcement']).toBe('Announcement');
    expect(after['dashboard.announcement.campaignStatus']).toBe('Campaign status');
    expect(diffRegion(rawBefore, rawAfter)).toMatchObject({ removed: 0, added: 1 });
  });

  it('updates an existing value in place, one line', async () => {
    const rawBefore = raw('locales/en.json');
    await toolUpsertTranslations({ entries: [{ key: 'dashboard.announcement', values: { en: 'Announcement (updated)' } }], overwrite: true }, ctxFor());
    const rawAfter = raw('locales/en.json');
    expect(diffRegion(rawBefore, rawAfter)).toMatchObject({ removed: 1, added: 1 });
    expect(flattenObject(JSON.parse(rawAfter))['dashboard.announcement.field57']).toBe('Announcement field 57');
  });

  it('updates a nested island leaf in place, one line', async () => {
    const rawBefore = raw('locales/en.json');
    await toolUpsertTranslations({ entries: [{ key: 'settings.profile.title', values: { en: 'Profile page' } }], overwrite: true }, ctxFor());
    const rawAfter = raw('locales/en.json');
    expect(diffRegion(rawBefore, rawAfter)).toMatchObject({ removed: 1, added: 1 });
  });

  it('I18N_STRUCTURE=nested reports an error and leaves the file intact', async () => {
    const rawBefore = raw('locales/en.json');
    await expect(
      toolUpsertTranslations({ entries: [{ key: 'component.group000.brandNewKey', values: { en: 'Brand new' } }] }, ctxFor({ I18N_STRUCTURE: 'nested' }))
    ).rejects.toThrow(/value and also the parent/);
    expect(raw('locales/en.json')).toBe(rawBefore);
  });
});

describe('single-key upsert scope on uniform files', () => {
  it('flat file: one added line', async () => {
    const doc: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) doc[`section.group.key${String(i).padStart(3, '0')}`] = `Value ${i}`;
    writeDoc('locales/en.json', doc);
    const before = raw('locales/en.json');
    await toolUpsertTranslations({ entries: [{ key: 'section.group.key250b', values: { en: 'Inserted' } }] }, ctxFor());
    expect(diffRegion(before, raw('locales/en.json'))).toMatchObject({ removed: 0, added: 1 });
  });

  it('nested file: one added line', async () => {
    const doc: Record<string, unknown> = {};
    for (let g = 0; g < 20; g++) {
      const group: Record<string, string> = {};
      for (let i = 0; i < 25; i++) group[`key${String(i).padStart(3, '0')}`] = `Value ${g}-${i}`;
      doc[`group${String(g).padStart(2, '0')}`] = group;
    }
    writeDoc('locales/en.json', doc);
    const before = raw('locales/en.json');
    await toolUpsertTranslations({ entries: [{ key: 'group10.key012b', values: { en: 'Inserted' } }] }, ctxFor());
    expect(diffRegion(before, raw('locales/en.json'))).toMatchObject({ removed: 0, added: 1 });
  });
});

// ─── delete ──────────────────────────────────────────────────────────────────

describe('i18n_delete_keys', () => {
  it('previews by default and deletes when dryRun is false', async () => {
    const ctx = copyFixture('flat-project');
    const preview = await toolDeleteKeys({ keys: ['greeting', 'nav.contact', 'zzz'] }, ctx);
    expect(preview.applied).toBe(false);
    expect(preview.dryRun).toBe(true);
    expect(preview.deleted).toEqual({ greeting: ['en', 'tr'], 'nav.contact': ['en'] });
    expect(preview.notFound).toEqual(['zzz']);
    expect(read('locales/en.json')).toHaveProperty('greeting');

    const out = await toolDeleteKeys({ keys: ['greeting', 'nav.contact'], dryRun: false }, ctx);
    expect(out.applied).toBe(true);
    expect(out.files).toEqual(['locales/en.json', 'locales/tr.json']);
    expect(read('locales/en.json')).not.toHaveProperty('greeting');
    expect(read('locales/tr.json')).not.toHaveProperty('greeting');
    expect(read('locales/en.json')).not.toHaveProperty('nav.contact');
  });

  it('honours a locale filter', async () => {
    const ctx = copyFixture('flat-project');
    const out = await toolDeleteKeys({ keys: ['greeting'], locales: ['tr'], dryRun: false }, ctx);
    expect(out.deleted).toEqual({ greeting: ['tr'] });
    expect(read('locales/en.json').greeting).toBe('Hello');
  });

  it('removes exactly one key from a colliding pair in a mixed file', async () => {
    writeDoc('locales/en.json', buildMixedLocale(200));
    const before = Object.keys(flattenObject(read('locales/en.json')));
    await toolDeleteKeys({ keys: ['dashboard.announcement'], dryRun: false }, ctxFor());
    const after = Object.keys(flattenObject(read('locales/en.json')));
    expect(before.filter(k => !after.includes(k))).toEqual(['dashboard.announcement']);
    expect(after).toContain('dashboard.announcement.field00');
  });
});

// ─── rename ──────────────────────────────────────────────────────────────────

describe('i18n_rename_key', () => {
  it('renames one key across locales, previewing by default', async () => {
    const ctx = copyFixture('flat-project');
    const preview = await toolRenameKey({ from: 'greeting', to: 'hello' }, ctx);
    expect(preview.applied).toBe(false);
    expect(preview.renamed).toEqual({ greeting: 'hello' });
    expect(preview.locales).toEqual(['en', 'tr']);
    expect(read('locales/en.json')).toHaveProperty('greeting');

    const out = await toolRenameKey({ from: 'greeting', to: 'hello', dryRun: false }, ctx);
    expect(out.applied).toBe(true);
    expect(read('locales/en.json').hello).toBe('Hello');
    expect(read('locales/tr.json').hello).toBe('Merhaba');
    expect(read('locales/en.json')).not.toHaveProperty('greeting');
  });

  it('skips locales that lack the source and refuses when the target exists anywhere', async () => {
    const ctx = copyFixture('flat-project');
    const out = await toolRenameKey({ from: 'nav.contact', to: 'nav.reach', dryRun: false }, ctx);
    expect(out.locales).toEqual(['en']);
    expect(out.skipped).toEqual(['tr']);

    await expect(toolRenameKey({ from: 'farewell', to: 'greeting', dryRun: false }, ctx)).rejects.toThrow(/already exists.*en, tr/);
    expect(read('locales/en.json').farewell).toBe('Goodbye');
  });

  it('moves a whole namespace when from ends with a dot, leaving a same-named leaf alone', async () => {
    writeDoc('locales/en.json', buildMixedLocale(200));
    const before = Object.keys(flattenObject(read('locales/en.json')));
    const out = await toolRenameKey({ from: 'campaign.status.', to: 'campaign.state.', dryRun: false }, ctxFor());
    expect(out.moved).toBe(24);
    expect(out.renamed['campaign.status.label00']).toBe('campaign.state.label00');
    const after = Object.keys(flattenObject(read('locales/en.json')));
    expect(after.length).toBe(before.length);
    expect(after).toContain('campaign.state.label00');
    expect(after).not.toContain('campaign.status.label00');
    expect(after).toContain('campaign.status');
  });

  it('rejects identical or blank names', async () => {
    const ctx = copyFixture('flat-project');
    await expect(toolRenameKey({ from: 'a', to: 'a' }, ctx)).rejects.toThrow(/differ/);
    await expect(toolRenameKey({ from: '', to: 'a' }, ctx)).rejects.toThrow(/required/);
  });
});

// ─── format ──────────────────────────────────────────────────────────────────

describe('i18n_format_resources', () => {
  it('previews by default, then sorts and rewrites', async () => {
    const ctx = copyFixture('flat-project');
    const preview = await toolFormatResources({}, ctx);
    expect(preview.applied).toBe(false);
    expect(preview.files).toEqual(['locales/en.json', 'locales/tr.json']);
    expect(Object.keys(read('locales/en.json'))[0]).toBe('greeting');

    const out = await toolFormatResources({ dryRun: false }, ctx);
    expect(out.applied).toBe(true);
    expect(Object.keys(read('locales/en.json'))[0]).toBe('btn.cancel');
    const again = await toolFormatResources({ dryRun: false }, ctx);
    expect(again.files).toEqual([]);
    expect(again.unchanged).toBe(2);
  });

  it('sorts a mixed file at the top level only and keeps every key', async () => {
    writeDoc('locales/en.json', buildMixedLocale(200));
    const before = Object.keys(flattenObject(read('locales/en.json')));
    const out = await toolFormatResources({ dryRun: false }, ctxFor());
    expect(out.files).toEqual(['locales/en.json']);
    const doc = read('locales/en.json');
    expect(Object.keys(flattenObject(doc)).sort()).toEqual(before.sort());
    expect(typeof doc['dashboard.announcement']).toBe('string');
    expect(Object.keys(doc)).toEqual([...Object.keys(doc)].sort((a, b) => a.localeCompare(b)));
  });
});
