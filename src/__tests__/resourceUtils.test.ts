import { describe, it, expect } from 'vitest';
import {
  isObjectNested,
  flattenObject,
  unflattenObject,
  orderKeys,
  reorderFlatMap,
  setNestedValue,
  deleteNestedKey,
  type FlatResourceMap,
} from '../resourceUtils';

describe('isObjectNested', () => {
  it('flat object → false', () => {
    expect(isObjectNested({ a: 'x', b: 'y' })).toBe(false);
  });

  it('nested object → true', () => {
    expect(isObjectNested({ a: { b: 'x' } })).toBe(true);
  });

  it('empty object → false', () => {
    expect(isObjectNested({})).toBe(false);
  });

  it('non-object → false', () => {
    expect(isObjectNested(null)).toBe(false);
    expect(isObjectNested('string')).toBe(false);
    expect(isObjectNested(42)).toBe(false);
    expect(isObjectNested([])).toBe(false);
  });
});

describe('flattenObject', () => {
  it('empty object → empty map', () => {
    expect(flattenObject({})).toEqual({});
  });

  it('flat object → same keys', () => {
    const input = { a: 'hello', b: 'world' };
    expect(flattenObject(input)).toEqual({ a: 'hello', b: 'world' });
  });

  it('nested 1 level → dotted keys', () => {
    const input = { user: { name: 'Alice', age: '30' } };
    expect(flattenObject(input)).toEqual({ 'user.name': 'Alice', 'user.age': '30' });
  });

  it('deeply nested → multi-segment keys', () => {
    const input = { a: { b: { c: 'deep' } } };
    expect(flattenObject(input)).toEqual({ 'a.b.c': 'deep' });
  });

  it('non-object input → empty', () => {
    expect(flattenObject('hello')).toEqual({});
    expect(flattenObject(null)).toEqual({});
    expect(flattenObject(undefined)).toEqual({});
  });

  it('numeric values → string coerced', () => {
    expect(flattenObject({ count: 5 })).toEqual({ count: '5' });
  });
});

describe('unflattenObject', () => {
  it('empty map → empty object', () => {
    expect(unflattenObject({})).toEqual({});
  });

  it('flat keys stay flat', () => {
    expect(unflattenObject({ a: 'x', b: 'y' })).toEqual({ a: 'x', b: 'y' });
  });

  it('dotted keys become nested', () => {
    const flat: FlatResourceMap = { 'user.name': 'Alice', 'user.age': '30' };
    expect(unflattenObject(flat)).toEqual({ user: { name: 'Alice', age: '30' } });
  });

  it('deeply nested', () => {
    const flat: FlatResourceMap = { 'a.b.c': 'deep' };
    expect(unflattenObject(flat)).toEqual({ a: { b: { c: 'deep' } } });
  });

  it('flatten then unflatten round-trip', () => {
    const original = { a: { b: 'x' }, c: 'y' };
    const result = unflattenObject(flattenObject(original));
    expect(result).toEqual(original);
  });
});

describe('orderKeys', () => {
  const initial = ['a', 'b', 'c'];
  const current = ['a', 'b', 'c', 'd'];
  const created = ['d'];

  it('sort strategy → alphabetical', () => {
    const result = orderKeys(initial, current, created, 'sort');
    expect(result).toEqual(['a', 'b', 'c', 'd']);
  });

  it('append strategy → initial order then new', () => {
    const result = orderKeys(initial, current, created, 'append');
    expect(result).toContain('a');
    expect(result).toContain('d');
    expect(result.indexOf('d')).toBeGreaterThanOrEqual(result.indexOf('c'));
  });

  it('nearby strategy → returns all current keys', () => {
    const result = orderKeys(initial, current, created, 'nearby');
    expect(new Set(result)).toEqual(new Set(current));
  });

  it('handles deletes in initial', () => {
    const after = ['a', 'c'];
    const result = orderKeys(initial, after, [], 'append');
    expect(result).toEqual(['a', 'c']);
  });

  it('empty initial → created keys appear', () => {
    const result = orderKeys([], ['x', 'y'], ['x', 'y'], 'append');
    expect(result).toEqual(expect.arrayContaining(['x', 'y']));
  });
});

describe('reorderFlatMap', () => {
  it('returns map with all current keys in correct order', () => {
    const initial: FlatResourceMap = { a: '1', b: '2', c: '3' };
    const current: FlatResourceMap = { a: 'A', b: 'B', c: 'C', d: 'D' };
    const result = reorderFlatMap(initial, current, ['d'], 'append');
    expect(Object.keys(result)).toEqual(expect.arrayContaining(['a', 'b', 'c', 'd']));
    expect(result['a']).toBe('A');
    expect(result['d']).toBe('D');
  });

  it('sort strategy → alphabetical output', () => {
    const initial: FlatResourceMap = { b: '2', a: '1', c: '3' };
    const current: FlatResourceMap = { b: '2', a: '1', c: '3' };
    const result = reorderFlatMap(initial, current, [], 'sort');
    expect(Object.keys(result)).toEqual(['a', 'b', 'c']);
  });
});

describe('setNestedValue', () => {
  it('sets top-level key', () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, 'key', 'value');
    expect(obj['key']).toBe('value');
  });

  it('sets nested key', () => {
    const obj: Record<string, unknown> = {};
    setNestedValue(obj, 'a.b.c', 'deep');
    expect((obj as any).a.b.c).toBe('deep');
  });

  it('overwrites existing value', () => {
    const obj: Record<string, unknown> = { x: 'old' };
    setNestedValue(obj, 'x', 'new');
    expect(obj['x']).toBe('new');
  });

  it('creates intermediate objects', () => {
    const obj: Record<string, unknown> = { a: {} };
    setNestedValue(obj, 'a.b', 'val');
    expect((obj as any).a.b).toBe('val');
  });
});

describe('deleteNestedKey', () => {
  it('deletes top-level key', () => {
    const obj: Record<string, unknown> = { a: '1', b: '2' };
    deleteNestedKey(obj, 'a');
    expect(obj).toEqual({ b: '2' });
  });

  it('deletes nested key', () => {
    const obj: Record<string, unknown> = { a: { b: '1', c: '2' } };
    deleteNestedKey(obj, 'a.b');
    expect((obj as any).a).toEqual({ c: '2' });
  });

  it('no-op for missing key', () => {
    const obj: Record<string, unknown> = { a: '1' };
    deleteNestedKey(obj, 'z');
    expect(obj).toEqual({ a: '1' });
  });

  it('no-op for missing nested path', () => {
    const obj: Record<string, unknown> = {};
    deleteNestedKey(obj, 'a.b.c');
    expect(obj).toEqual({});
  });
});
