import { describe, it, expect } from 'vitest';
import { extractPlaceholders, comparePlaceholders } from '../core/placeholders';

describe('extractPlaceholders', () => {
  it('empty or undefined → empty set', () => {
    expect(extractPlaceholders('').size).toBe(0);
    expect(extractPlaceholders(undefined).size).toBe(0);
  });

  it('finds {{name}}, {count} and positional {0}', () => {
    expect(Array.from(extractPlaceholders('Hi {{name}}, {count} items, {0} of {1}'))).toEqual(['name', 'count', '0', '1']);
  });

  it('ignores whitespace inside braces', () => {
    expect(Array.from(extractPlaceholders('{{ name }} { count }'))).toEqual(['name', 'count']);
  });
});

describe('comparePlaceholders', () => {
  it('reports placeholders missing from and extra in the compared value', () => {
    expect(comparePlaceholders('You have {count} of {total}', 'Sende {adet} var')).toEqual({
      missing: ['count', 'total'],
      extra: ['adet'],
    });
  });

  it('returns undefined when both sides agree', () => {
    expect(comparePlaceholders('Welcome {{name}}!', 'Hoş geldin {{name}}!')).toBeUndefined();
  });
});
