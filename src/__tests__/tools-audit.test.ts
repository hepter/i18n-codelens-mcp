import { describe, it, expect, beforeEach } from 'vitest';
import path from 'path';
import { createToolContext } from '../tools/shared';
import { toolAudit } from '../tools/audit';
import { clearResourceCache } from '../core/resources';
import { clearCodeIndexCache } from '../core/code-index';

const FIXTURES = path.resolve(__dirname, '..', '..', 'fixtures');
const flat = () => createToolContext({ workspaceRoot: path.join(FIXTURES, 'flat-project'), env: {} });
const namespaced = () => createToolContext({ workspaceRoot: path.join(FIXTURES, 'namespaced-project'), env: {} });

beforeEach(() => {
  clearResourceCache();
  clearCodeIndexCache();
});

describe('i18n_audit', () => {
  it('runs every check by default and reports compact sections', async () => {
    const out = await toolAudit({}, flat());
    expect(out.base).toBe('en');
    expect(out.locales).toEqual(['en', 'tr']);
    expect(out.summary).toEqual({ missing: 4, extra: 0, placeholders: 1, code: 6, unused: 0 });
    expect(out.missing).toEqual({ 'nav.contact': ['tr'], 'msg.error': ['tr'], 'btn.cancel': ['tr'], 'btn.delete': ['tr'] });
    expect(out.placeholders).toEqual([{ key: 'msg.count', locale: 'tr', missing: ['count'], extra: ['adet'] }]);
    expect(out.code).toEqual({
      'another.missing': ['en', 'tr'],
      'btn.cancel': ['tr'],
      'btn.delete': ['tr'],
      'missing.key': ['en', 'tr'],
      'msg.error': ['tr'],
      'nav.contact': ['tr'],
    });
    expect(out).not.toHaveProperty('unused');
    expect(out).not.toHaveProperty('extra');
    expect(out).not.toHaveProperty('truncated');
  });

  it('runs only the requested checks', async () => {
    const out = await toolAudit({ checks: ['unused', 'placeholders'] }, flat());
    expect(Object.keys(out.summary).sort()).toEqual(['placeholders', 'unused']);
    expect(out).not.toHaveProperty('missing');
    expect(out).not.toHaveProperty('code');
    expect(out.placeholders).toHaveLength(1);
  });

  it('attaches code references when asked', async () => {
    const out = await toolAudit({ checks: ['code'], includeReferences: true }, flat());
    expect(out.code!['missing.key']).toEqual({ missing: ['en', 'tr'], refs: ['src/main.ts:23:23'] });
  });

  it('limits every section and says which were cut', async () => {
    const out = await toolAudit({ limit: 2 }, flat());
    expect(out.summary.missing).toBe(4);
    expect(Object.keys(out.missing!)).toHaveLength(2);
    expect(Object.keys(out.code!)).toHaveLength(2);
    expect(out.truncated).toEqual(['missing', 'code']);
  });

  it('accepts a base locale and a locale subset, and rejects an unknown base', async () => {
    const out = await toolAudit({ baseLocale: 'tr', locales: ['en'], checks: ['missing'] }, flat());
    expect(out.base).toBe('tr');
    expect(out.locales).toEqual(['tr', 'en']);
    expect(out.summary.missing).toBe(0);
    expect(out.summary.extra).toBe(4);
    expect(out.extra).toEqual({ en: ['nav.contact', 'msg.error', 'btn.cancel', 'btn.delete'] });
    await expect(toolAudit({ baseLocale: 'de' }, flat())).rejects.toThrow(/Available locales: en, tr/);
  });

  it('finds unused keys and understands namespaced keys', async () => {
    const out = await toolAudit({ checks: ['unused', 'code', 'missing'] }, namespaced());
    expect(out.unused).toEqual(['auth:login.hint']);
    expect(out.code).toEqual({ 'auth:login.forgot': ['en', 'tr'], 'common:nav.about': ['tr'] });
    expect(out.missing).toEqual({ 'common:nav.about': ['tr'] });
  });

  it('surfaces project warnings such as duplicate locale files', async () => {
    const out = await toolAudit({ checks: ['missing'] }, flat());
    expect(out).not.toHaveProperty('warnings');
  });
});
