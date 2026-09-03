/**
 * Regression tests for the 2026-09-03 key-loss incident.
 *
 * A real locale file with 5,924 flat dotted keys and three nested islands was
 * classified as "nested" by isObjectNested, converted whole-document on the next
 * single-key upsert, and lost 397 keys because a leaf and a namespace shared a
 * name (`dashboard.announcement` was both a string and the parent of 58 keys).
 *
 * These tests describe the contract that makes that impossible:
 *   1. No write path may reduce the key set.
 *   2. A mixed file is never converted; keys stay where they already are.
 *   3. A single-key upsert touches a single line.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  toolUpsertTranslations,
  toolDeleteKey,
  toolRenameKey,
  toolMoveNamespace,
  toolFormatResources,
} from '../server';
import { flattenObject, unflattenObject, classifyResourceStructure } from '../resourceUtils';
import { writeFilePretty } from '../i18nFs';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Measure the changed region of a line diff: strip the common leading and
 * trailing lines, whatever is left is what the write actually touched.
 */
function diffRegion(before: string, after: string): { added: number; removed: number; addedLines: string[] } {
  const a = before.split('\n');
  const b = after.split('\n');
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix++;
  return {
    removed: a.length - prefix - suffix,
    added: b.length - prefix - suffix,
    addedLines: b.slice(prefix, b.length - suffix),
  };
}

/**
 * A mixed locale file in the shape of the one that was destroyed: thousands of
 * flat dotted keys, a handful of nested islands, and a leaf whose name is also
 * a namespace.
 */
function buildMixedLocale(flatKeyCount: number): Record<string, unknown> {
  const doc: Record<string, unknown> = {};

  for (let i = 0; i < flatKeyCount; i++) {
    const group = `group${String(Math.floor(i / 40)).padStart(3, '0')}`;
    doc[`component.${group}.key${String(i).padStart(4, '0')}`] = `Value ${i}`;
  }

  // The collision that did the damage: a leaf AND a namespace with one name.
  // Order one, leaf first: the leaf's value is destroyed when a child is walked.
  doc['dashboard.announcement'] = 'Announcement';
  for (let i = 0; i < 58; i++) {
    doc[`dashboard.announcement.field${String(i).padStart(2, '0')}`] = `Announcement field ${i}`;
  }

  // Order two, namespace first: every child is destroyed when the leaf is written.
  for (let i = 0; i < 24; i++) {
    doc[`campaign.status.label${String(i).padStart(2, '0')}`] = `Status label ${i}`;
  }
  doc['campaign.status'] = 'Status';

  // Three nested islands, which is all it took to make the whole file "nested".
  doc.settings = { profile: { title: 'Profile', subtitle: 'Your profile' } };
  doc.errors = { notFound: 'Not found', forbidden: 'Forbidden' };
  doc.wizard = { steps: { first: 'First', last: 'Last' } };

  return doc;
}

let tmpDir: string;
let enFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-mixed-'));
  fs.mkdirSync(path.join(tmpDir, 'locales'), { recursive: true });
  enFile = path.join(tmpDir, 'locales', 'en.json');
  fs.writeFileSync(enFile, JSON.stringify(buildMixedLocale(3000), null, 2) + '\n', 'utf8');
  process.env.I18N_GLOB = '**/locales/*.json';
});

afterEach(() => {
  delete process.env.I18N_GLOB;
  delete process.env.I18N_STRUCTURE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── The incident ────────────────────────────────────────────────────────────

describe('mixed locale file: single-key upsert', () => {
  it('does not lose a single key', async () => {
    const rawBefore = fs.readFileSync(enFile, 'utf8');
    const before = flattenObject(JSON.parse(rawBefore));

    await toolUpsertTranslations({
      entries: [{ key: 'component.group000.brandNewKey', values: { en: 'Brand new' } }],
      dryRun: false,
      workspaceDir: tmpDir,
    });

    const after = flattenObject(JSON.parse(fs.readFileSync(enFile, 'utf8')));
    const lost = Object.keys(before).filter(k => !Object.prototype.hasOwnProperty.call(after, k));

    expect(lost).toEqual([]);
    expect(Object.keys(after).sort()).toEqual(
      [...Object.keys(before), 'component.group000.brandNewKey'].sort()
    );
    expect(after['dashboard.announcement']).toBe('Announcement');
    expect(after['dashboard.announcement.field00']).toBe('Announcement field 0');
    expect(after['campaign.status']).toBe('Status');
    expect(after['campaign.status.label00']).toBe('Status label 0');
    expect(after['component.group000.brandNewKey']).toBe('Brand new');
  });

  it('writes a single line and converts nothing', async () => {
    const rawBefore = fs.readFileSync(enFile, 'utf8');

    await toolUpsertTranslations({
      entries: [{ key: 'component.group000.brandNewKey', values: { en: 'Brand new' } }],
      dryRun: false,
      workspaceDir: tmpDir,
    });

    const rawAfter = fs.readFileSync(enFile, 'utf8');
    const region = diffRegion(rawBefore, rawAfter);

    expect(region.removed).toBe(0);
    expect(region.added).toBe(1);
    expect(region.addedLines[0]).toContain('component.group000.brandNewKey');

    // The nested islands are still islands and the flat keys are still flat.
    const doc = JSON.parse(rawAfter) as Record<string, unknown>;
    expect(typeof doc['component.group000.key0000']).toBe('string');
    expect(typeof doc['dashboard.announcement']).toBe('string');
    expect((doc.settings as Record<string, unknown>).profile).toEqual({
      title: 'Profile',
      subtitle: 'Your profile',
    });
  });

  it('adds a key under a colliding namespace without touching the leaf', async () => {
    // The exact operation that triggered the incident: a new key whose parent
    // name is also a value.
    const rawBefore = fs.readFileSync(enFile, 'utf8');
    const before = flattenObject(JSON.parse(rawBefore));

    await toolUpsertTranslations({
      entries: [{ key: 'dashboard.announcement.campaignStatus', values: { en: 'Campaign status' } }],
      dryRun: false,
      workspaceDir: tmpDir,
    });

    const rawAfter = fs.readFileSync(enFile, 'utf8');
    const after = flattenObject(JSON.parse(rawAfter));
    expect(Object.keys(before).filter(k => !Object.prototype.hasOwnProperty.call(after, k))).toEqual([]);
    expect(after['dashboard.announcement']).toBe('Announcement');
    expect(after['dashboard.announcement.campaignStatus']).toBe('Campaign status');

    const region = diffRegion(rawBefore, rawAfter);
    expect(region.removed).toBe(0);
    expect(region.added).toBe(1);
  });

  it('updating an existing value edits it in place', async () => {
    const rawBefore = fs.readFileSync(enFile, 'utf8');

    await toolUpsertTranslations({
      entries: [{ key: 'dashboard.announcement', values: { en: 'Announcement (updated)' } }],
      dryRun: false,
      workspaceDir: tmpDir,
    });

    const rawAfter = fs.readFileSync(enFile, 'utf8');
    const region = diffRegion(rawBefore, rawAfter);
    expect(region.removed).toBe(1);
    expect(region.added).toBe(1);

    const after = flattenObject(JSON.parse(rawAfter));
    expect(after['dashboard.announcement']).toBe('Announcement (updated)');
    expect(after['dashboard.announcement.field57']).toBe('Announcement field 57');
  });
});

// ─── The loss itself ─────────────────────────────────────────────────────────

describe('unflattenObject refuses to destroy a value', () => {
  it('throws when a leaf is walked before its namespace', () => {
    expect(() =>
      unflattenObject({
        'dashboard.announcement': 'Announcement',
        'dashboard.announcement.campaignStatus': 'Campaign status',
      })
    ).toThrow(/dashboard\.announcement/);
  });

  it('throws when a namespace is walked before its leaf', () => {
    expect(() =>
      unflattenObject({
        'dashboard.announcement.campaignStatus': 'Campaign status',
        'dashboard.announcement': 'Announcement',
      })
    ).toThrow(/dashboard\.announcement/);
  });

  it('still round-trips a file with no collision', () => {
    const flat = { 'a.b': 'x', 'a.c': 'y', d: 'z' };
    expect(unflattenObject(flat)).toEqual({ a: { b: 'x', c: 'y' }, d: 'z' });
  });
});

// ─── The write boundary ──────────────────────────────────────────────────────

describe('writeFilePretty key-loss guard', () => {
  it('refuses a write that would drop an existing key', () => {
    const file = path.join(tmpDir, 'locales', 'guard.json');
    fs.writeFileSync(file, JSON.stringify({ keep: 'a', drop: 'b' }, null, 2) + '\n', 'utf8');

    expect(() => writeFilePretty(file, { keep: 'a' }, tmpDir)).toThrow(/drop/);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ keep: 'a', drop: 'b' });
  });

  it('allows a removal the caller declared', () => {
    const file = path.join(tmpDir, 'locales', 'guard2.json');
    fs.writeFileSync(file, JSON.stringify({ keep: 'a', drop: 'b' }, null, 2) + '\n', 'utf8');

    writeFilePretty(file, { keep: 'a' }, tmpDir, { allowRemovedKeys: ['drop'] });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ keep: 'a' });
  });

  it('allows any write to a file that does not exist yet', () => {
    const file = path.join(tmpDir, 'locales', 'fresh.json');
    writeFilePretty(file, { a: 'x' }, tmpDir);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ a: 'x' });
  });
});

// ─── Every other write path on a mixed file ──────────────────────────────────

describe('mixed locale file: the other write tools', () => {
  async function keysAfter(run: () => Promise<unknown>): Promise<{ before: string[]; after: string[] }> {
    const before = Object.keys(flattenObject(JSON.parse(fs.readFileSync(enFile, 'utf8'))));
    await run();
    const after = Object.keys(flattenObject(JSON.parse(fs.readFileSync(enFile, 'utf8'))));
    return { before, after };
  }

  it('delete removes exactly the requested key', async () => {
    const { before, after } = await keysAfter(() =>
      toolDeleteKey({ key: 'dashboard.announcement', dryRun: false, workspaceDir: tmpDir })
    );
    expect(before.filter(k => !after.includes(k))).toEqual(['dashboard.announcement']);
    expect(after).toContain('dashboard.announcement.field00');
  });

  it('rename moves exactly one key', async () => {
    const { before, after } = await keysAfter(() =>
      toolRenameKey({ from: 'campaign.status', to: 'campaign.statusLabel', dryRun: false, workspaceDir: tmpDir })
    );
    expect(before.filter(k => !after.includes(k))).toEqual(['campaign.status']);
    expect(after.filter(k => !before.includes(k))).toEqual(['campaign.statusLabel']);
    expect(after).toContain('campaign.status.label00');
  });

  it('namespace move keeps every key in the file', async () => {
    const { before, after } = await keysAfter(() =>
      toolMoveNamespace({ from: 'campaign.status', to: 'campaign.state', dryRun: false, workspaceDir: tmpDir })
    );
    expect(before.length).toBe(after.length);
    expect(after).toContain('campaign.state.label00');
    expect(after).not.toContain('campaign.status.label00');
    // The leaf that shares the namespace name is untouched by the move.
    expect(after).toContain('campaign.status');
  });

  it('format sorts a mixed file without restructuring it', async () => {
    const before = Object.keys(flattenObject(JSON.parse(fs.readFileSync(enFile, 'utf8'))));
    const result = await toolFormatResources({ dryRun: false, workspaceDir: tmpDir });
    const raw = fs.readFileSync(enFile, 'utf8');
    const doc = JSON.parse(raw) as Record<string, unknown>;

    expect(result.summary.errors).toBe(0);
    expect(Object.keys(flattenObject(doc)).sort()).toEqual(before.sort());
    expect(typeof doc['dashboard.announcement']).toBe('string');
    expect(typeof doc['dashboard.announcement.field00']).toBe('string');
    expect(Object.keys(doc)).toEqual([...Object.keys(doc)].sort((a, b) => a.localeCompare(b)));
  });

  it('an in-place update of a nested island leaf touches one line', async () => {
    const rawBefore = fs.readFileSync(enFile, 'utf8');
    await toolUpsertTranslations({
      entries: [{ key: 'settings.profile.title', values: { en: 'Profile page' } }],
      dryRun: false,
      workspaceDir: tmpDir,
    });
    const rawAfter = fs.readFileSync(enFile, 'utf8');
    const region = diffRegion(rawBefore, rawAfter);

    expect(region.removed).toBe(1);
    expect(region.added).toBe(1);
    const doc = JSON.parse(rawAfter) as Record<string, unknown>;
    const settings = doc.settings as Record<string, Record<string, string>>;
    expect(settings.profile.title).toBe('Profile page');
  });
});

// ─── A mixed file whose leaves are mostly nested ─────────────────────────────

describe('mixed locale file with nested dominance', () => {
  let nestedDir: string;
  let nestedFile: string;

  beforeEach(() => {
    nestedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-nested-'));
    fs.mkdirSync(path.join(nestedDir, 'locales'), { recursive: true });
    nestedFile = path.join(nestedDir, 'locales', 'en.json');
    const doc: Record<string, unknown> = {
      nav: { home: 'Home', about: 'About' },
      msg: { welcome: 'Welcome', bye: 'Bye' },
      // One flat dotted leftover makes the file mixed, and it is also a name
      // that a nested placement would have to overwrite.
      'legacy.key': 'Legacy',
      legacy: 'Legacy root',
    };
    fs.writeFileSync(nestedFile, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    process.env.I18N_GLOB = '**/locales/*.json';
  });

  afterEach(() => {
    fs.rmSync(nestedDir, { recursive: true, force: true });
  });

  it('classifies the file as mixed and nested-dominant', () => {
    const structure = classifyResourceStructure(JSON.parse(fs.readFileSync(nestedFile, 'utf8')));
    expect(structure.kind).toBe('mixed');
    expect(structure.dominant).toBe('nested');
  });

  it('adds a new key nested, and keeps every existing key', async () => {
    await toolUpsertTranslations({
      entries: [{ key: 'nav.contact', values: { en: 'Contact' } }],
      dryRun: false,
      workspaceDir: nestedDir,
    });
    const doc = JSON.parse(fs.readFileSync(nestedFile, 'utf8')) as Record<string, unknown>;
    expect((doc.nav as Record<string, unknown>).contact).toBe('Contact');
    expect(doc['legacy.key']).toBe('Legacy');
    expect(doc.legacy).toBe('Legacy root');
  });

  it('falls back to a flat key when the nested path is blocked by a value', async () => {
    await toolUpsertTranslations({
      entries: [{ key: 'legacy.other', values: { en: 'Other' } }],
      dryRun: false,
      workspaceDir: nestedDir,
    });
    const doc = JSON.parse(fs.readFileSync(nestedFile, 'utf8')) as Record<string, unknown>;
    // 'legacy' holds a value, so 'legacy.other' cannot nest under it.
    expect(doc.legacy).toBe('Legacy root');
    expect(doc['legacy.other']).toBe('Other');
    expect(doc['legacy.key']).toBe('Legacy');
  });
});

// ─── Structure classification ────────────────────────────────────────────────

describe('classifyResourceStructure', () => {
  it('calls a document with only dotted keys flat', () => {
    const s = classifyResourceStructure({ 'a.b': 'x', 'a.c': 'y' });
    expect(s.kind).toBe('flat');
    expect(s.dominant).toBe('flat');
  });

  it('calls a document with only objects nested', () => {
    const s = classifyResourceStructure({ a: { b: 'x' }, c: { d: 'y' } });
    expect(s.kind).toBe('nested');
    expect(s.dominant).toBe('nested');
  });

  it('calls a document with both mixed, and picks the majority style', () => {
    const doc: Record<string, unknown> = { island: { one: 'x', two: 'y' } };
    for (let i = 0; i < 50; i++) doc[`flat.key${i}`] = `v${i}`;
    const s = classifyResourceStructure(doc);
    expect(s.kind).toBe('mixed');
    expect(s.dominant).toBe('flat');
    expect(s.flatLeafCount).toBe(50);
    expect(s.nestedLeafCount).toBe(2);
  });

  it('does not call a nested file with plain top-level keys mixed', () => {
    const s = classifyResourceStructure({ greeting: 'Hello', nav: { home: 'Home' } });
    expect(s.kind).toBe('nested');
  });

  it('treats an empty document as flat', () => {
    expect(classifyResourceStructure({}).kind).toBe('flat');
  });
});

// ─── Scope on uniform files, which must not have regressed ───────────────────

describe('single-key upsert scope on uniform files', () => {
  let uniformDir: string;
  let uniformFile: string;

  function setupUniform(doc: Record<string, unknown>): void {
    uniformDir = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-uniform-'));
    fs.mkdirSync(path.join(uniformDir, 'locales'), { recursive: true });
    uniformFile = path.join(uniformDir, 'locales', 'en.json');
    fs.writeFileSync(uniformFile, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    process.env.I18N_GLOB = '**/locales/*.json';
  }

  afterEach(() => {
    if (uniformDir) fs.rmSync(uniformDir, { recursive: true, force: true });
  });

  it('flat file: one added line, nothing else', async () => {
    const doc: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) doc[`section.group.key${String(i).padStart(3, '0')}`] = `Value ${i}`;
    setupUniform(doc);

    const rawBefore = fs.readFileSync(uniformFile, 'utf8');
    await toolUpsertTranslations({
      entries: [{ key: 'section.group.key250b', values: { en: 'Inserted' } }],
      dryRun: false,
      workspaceDir: uniformDir,
    });
    const region = diffRegion(rawBefore, fs.readFileSync(uniformFile, 'utf8'));

    expect(region.removed).toBe(0);
    expect(region.added).toBe(1);
  });

  it('nested file: one added line, nothing else', async () => {
    const doc: Record<string, unknown> = {};
    for (let g = 0; g < 20; g++) {
      const group: Record<string, string> = {};
      for (let i = 0; i < 25; i++) group[`key${String(i).padStart(3, '0')}`] = `Value ${g}-${i}`;
      doc[`group${String(g).padStart(2, '0')}`] = group;
    }
    setupUniform(doc);

    const rawBefore = fs.readFileSync(uniformFile, 'utf8');
    await toolUpsertTranslations({
      entries: [{ key: 'group10.key012b', values: { en: 'Inserted' } }],
      dryRun: false,
      workspaceDir: uniformDir,
    });
    const region = diffRegion(rawBefore, fs.readFileSync(uniformFile, 'utf8'));

    expect(region.removed).toBe(0);
    expect(region.added).toBe(1);
  });
});

// ─── Forced structure still cannot lose data ─────────────────────────────────

describe('I18N_STRUCTURE=nested on a colliding file', () => {
  it('reports an error instead of writing a lossy document', async () => {
    process.env.I18N_STRUCTURE = 'nested';
    const rawBefore = fs.readFileSync(enFile, 'utf8');

    let threw = false;
    try {
      await toolUpsertTranslations({
        entries: [{ key: 'component.group000.brandNewKey', values: { en: 'Brand new' } }],
        dryRun: false,
        workspaceDir: tmpDir,
      });
    } catch {
      threw = true;
    }

    const rawAfter = fs.readFileSync(enFile, 'utf8');
    const after = flattenObject(JSON.parse(rawAfter));
    const before = flattenObject(JSON.parse(rawBefore));
    const lost = Object.keys(before).filter(k => !Object.prototype.hasOwnProperty.call(after, k));

    expect(threw).toBe(true);
    expect(lost).toEqual([]);
  });
});
