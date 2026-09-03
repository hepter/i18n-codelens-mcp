import { describe, it, expect } from 'vitest';
import { normalizeLocaleTag, looksLikeLocaleTag, describeLocale, detectLocaleFromFileName } from '../core/locale';

describe('normalizeLocaleTag', () => {
  it('empty string → empty string', () => {
    expect(normalizeLocaleTag('')).toBe('');
  });

  it('lowercases the language and uppercases the region', () => {
    expect(normalizeLocaleTag('EN')).toBe('en');
    expect(normalizeLocaleTag('en-us')).toBe('en-US');
    expect(normalizeLocaleTag('en_US')).toBe('en-US');
  });

  it('strips .json extension', () => {
    expect(normalizeLocaleTag('tr.json')).toBe('tr');
  });

  it('title-cases a script subtag', () => {
    expect(normalizeLocaleTag('zh-hans-cn')).toBe('zh-Hans-CN');
  });
});

describe('looksLikeLocaleTag', () => {
  it('accepts plain languages and language-region pairs', () => {
    for (const tag of ['en', 'tr', 'en-US', 'pt_BR', 'zh-Hans-CN', 'fil']) expect(looksLikeLocaleTag(tag)).toBe(true);
  });

  it('rejects namespace-like and unknown names', () => {
    for (const name of ['common', 'translation', 'app', 'config', 'messages.en', '', 'en-']) expect(looksLikeLocaleTag(name)).toBe(false);
  });
});

describe('detectLocaleFromFileName', () => {
  it('returns the tag when the whole name is a locale', () => {
    expect(detectLocaleFromFileName('en')).toBe('en');
    expect(detectLocaleFromFileName('pt_BR')).toBe('pt-BR');
  });

  it('finds a locale suffix such as messages.en-US', () => {
    expect(detectLocaleFromFileName('messages.en-US')).toBe('en-US');
  });

  it('returns undefined for a namespace-like name', () => {
    expect(detectLocaleFromFileName('common')).toBeUndefined();
  });
});

describe('describeLocale', () => {
  it('returns an English description for en and undefined-safe output for junk', () => {
    expect(describeLocale('en')).toContain('English');
    expect(describeLocale('tr-TR')).toContain('Turkish');
    expect(() => describeLocale('not a tag!!')).not.toThrow();
  });
});
