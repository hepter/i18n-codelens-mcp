import { describe, it, expect } from 'vitest';
import {
  includesSearchText,
  limitItems,
  normalizeLimit,
  previewText,
  shouldDryRun,
  uniqueStrings,
} from '../toolUtils';

describe('normalizeLimit', () => {
  it('uses fallback for invalid input', () => {
    expect(normalizeLimit(undefined, 7)).toBe(7);
    expect(normalizeLimit(Number.NaN, 7)).toBe(7);
  });

  it('clamps to min and max', () => {
    expect(normalizeLimit(0, 10, 20)).toBe(1);
    expect(normalizeLimit(25, 10, 20)).toBe(20);
  });
});

describe('limitItems', () => {
  it('returns compact pagination metadata', () => {
    const res = limitItems([1, 2, 3], 2);
    expect(res.total).toBe(3);
    expect(res.limit).toBe(2);
    expect(res.truncated).toBe(true);
    expect(res.items).toEqual([1, 2]);
  });
});

describe('previewText', () => {
  it('truncates long text without returning the full value', () => {
    expect(previewText('abcdef', 4)).toBe('abc…');
  });

  it('handles nullish values as empty strings', () => {
    expect(previewText(undefined)).toBe('');
    expect(previewText(null)).toBe('');
  });
});

describe('shouldDryRun', () => {
  it('defaults to true unless explicitly false', () => {
    expect(shouldDryRun(undefined)).toBe(true);
    expect(shouldDryRun(true)).toBe(true);
    expect(shouldDryRun(false)).toBe(false);
  });
});

describe('uniqueStrings', () => {
  it('trims, removes empty values, and deduplicates', () => {
    expect(uniqueStrings([' en ', '', 'en', 'tr'])).toEqual(['en', 'tr']);
  });
});

describe('includesSearchText', () => {
  it('searches case-insensitively by default', () => {
    expect(includesSearchText('Navigation Home', 'home')).toBe(true);
  });

  it('supports case-sensitive search', () => {
    expect(includesSearchText('Navigation Home', 'home', true)).toBe(false);
  });
});
