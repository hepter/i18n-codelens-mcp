import { distance } from 'fastest-levenshtein';
import type { InsertOrderStrategy } from './config';

export type FlatResourceMap = Record<string, string>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when the document contains at least one nested object. This answers
 * "does anything nest here", NOT "is this document nested in style" - a mixed
 * file answers true on the strength of a single island. Use
 * classifyResourceStructure to decide how to write.
 */
export function isObjectNested(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (isPlainObject((value as Record<string, unknown>)[key])) return true;
  }
  return false;
}

export type ResourceStructureKind = 'flat' | 'nested' | 'mixed';

export type ResourceStructure = {
  /** flat: dotted keys only. nested: objects only. mixed: both in one file. */
  kind: ResourceStructureKind;
  /** Which style holds most of the leaves; where a new key should go. */
  dominant: 'flat' | 'nested';
  /** Leaves stored as a top-level property. */
  flatLeafCount: number;
  /** Leaves stored inside at least one object. */
  nestedLeafCount: number;
};

/**
 * Classify a locale document by how its leaves are actually stored, so a mixed
 * file is recognised as mixed instead of being converted to whichever style
 * happens to appear first. See specs in README: a single nested island must not
 * decide the shape of a document with thousands of flat keys.
 */
export function classifyResourceStructure(value: unknown, separator = '.'): ResourceStructure {
  let flatLeafCount = 0;
  let nestedLeafCount = 0;
  let hasDottedName = false;
  let hasNestedObject = false;

  const walk = (node: Record<string, unknown>, depth: number): void => {
    for (const key of Object.keys(node)) {
      if (key.includes(separator)) hasDottedName = true;
      const child = node[key];
      if (isPlainObject(child)) {
        hasNestedObject = true;
        walk(child, depth + 1);
      } else if (depth === 0) {
        flatLeafCount += 1;
      } else {
        nestedLeafCount += 1;
      }
    }
  };

  if (isPlainObject(value)) walk(value, 0);

  const kind: ResourceStructureKind =
    hasDottedName && hasNestedObject ? 'mixed' : hasNestedObject ? 'nested' : 'flat';
  return {
    kind,
    dominant: nestedLeafCount > flatLeafCount ? 'nested' : 'flat',
    flatLeafCount,
    nestedLeafCount,
  };
}

export type KeyCollision = {
  /** The key that holds a value. */
  leafKey: string;
  /** A key that needs leafKey to be an object instead. */
  childKey: string;
};

/**
 * Find keys that are used both as a value and as a namespace. Such a pair
 * cannot exist in a nested document: one of the two has to be destroyed to
 * write the other, which is exactly how 397 keys were lost on 2026-09-03.
 */
export function findKeyCollisions(map: FlatResourceMap, separator = '.'): KeyCollision[] {
  const collisions: KeyCollision[] = [];
  const keys = Object.keys(map);
  const keySet = new Set(keys);
  for (const key of keys) {
    const segments = key.split(separator);
    for (let i = 1; i < segments.length; i++) {
      const prefix = segments.slice(0, i).join(separator);
      if (keySet.has(prefix)) collisions.push({ leafKey: prefix, childKey: key });
    }
  }
  return collisions;
}

function describeCollisions(collisions: KeyCollision[]): string {
  const shown = collisions.slice(0, 3).map(c => `'${c.leafKey}' is a value and also the parent of '${c.childKey}'`);
  const rest = collisions.length > shown.length ? `, and ${collisions.length - shown.length} more` : '';
  return `${shown.join('; ')}${rest}`;
}

export function flattenObject(value: unknown, prefix = '', separator = '.'): FlatResourceMap {
  const flattened: FlatResourceMap = {};
  if (!isPlainObject(value)) return flattened;
  for (const key of Object.keys(value)) {
    const next = (value as Record<string, unknown>)[key];
    const nextKey = prefix ? `${prefix}${separator}${key}` : key;
    if (isPlainObject(next)) {
      Object.assign(flattened, flattenObject(next, nextKey, separator));
    } else {
      flattened[nextKey] = String(next);
    }
  }
  return flattened;
}

/**
 * Like flattenObject, but records the real property path of every leaf so a
 * caller can write a key back exactly where it already lives. Traversal order
 * matches flattenObject, so both agree on the winner of a duplicated key.
 */
export function flattenObjectPaths(value: unknown, prefix: string[] = [], separator = '.'): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  if (!isPlainObject(value)) return paths;
  for (const key of Object.keys(value)) {
    const next = (value as Record<string, unknown>)[key];
    const nextPath = [...prefix, key];
    if (isPlainObject(next)) {
      Object.assign(paths, flattenObjectPaths(next, nextPath, separator));
    } else {
      paths[nextPath.join(separator)] = nextPath;
    }
  }
  return paths;
}

/**
 * Build a nested document from a flat map.
 *
 * Throws instead of dropping data when a key is both a value and a namespace.
 * The old implementation replaced whichever of the two arrived first, silently.
 */
export function unflattenObject(map: FlatResourceMap, separator = '.'): Record<string, unknown> {
  const collisions = findKeyCollisions(map, separator);
  if (collisions.length) {
    throw new Error(
      `Cannot write a nested document: ${collisions.length} key(s) are used both as a value and as a namespace (${describeCollisions(collisions)}). ` +
      'Rename one side of each pair, or leave the file in its current shape (I18N_STRUCTURE=auto).'
    );
  }

  const result: Record<string, unknown> = {};
  for (const flatKey of Object.keys(map)) {
    const segments = flatKey.split(separator);
    if (segments.includes('__proto__')) {
      throw new Error(`Refusing to write key '${flatKey}': '__proto__' is not a usable key segment.`);
    }
    let current: Record<string, unknown> = result;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      if (!Object.prototype.hasOwnProperty.call(current, segment)) current[segment] = {};
      // Defensive: the collision scan above should make this unreachable.
      if (!isPlainObject(current[segment])) {
        throw new Error(`Cannot write a nested document: '${segments.slice(0, i + 1).join(separator)}' is both a value and a namespace.`);
      }
      current = current[segment] as Record<string, unknown>;
    }
    const lastSegment = segments[segments.length - 1];
    if (isPlainObject(current[lastSegment])) {
      throw new Error(`Cannot write a nested document: '${flatKey}' is both a value and a namespace.`);
    }
    current[lastSegment] = map[flatKey];
  }
  return result;
}

/** Rebuild an object with its top-level properties in the given order. */
export function reorderTopLevel(json: Record<string, unknown>, orderedKeys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of orderedKeys) {
    if (Object.prototype.hasOwnProperty.call(json, key)) out[key] = json[key];
  }
  for (const key of Object.keys(json)) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = json[key];
  }
  return out;
}

/**
 * Compute a final ordered list of keys.
 * - initialKeys: original key order before modifications
 * - currentKeys: keys present after modifications
 * - createdKeys: newly created keys in creation order
 * - strategy: append | nearby | sort
 */
export function orderKeys(
  initialKeys: string[],
  currentKeys: string[],
  createdKeys: string[],
  strategy: InsertOrderStrategy
): string[] {
  const baseKeys = initialKeys.filter(k => currentKeys.includes(k));
  const newKeys = createdKeys.filter(k => currentKeys.includes(k));

  if (strategy === 'sort') {
    return [...currentKeys].sort((a, b) => a.localeCompare(b));
  }

  if (strategy === 'append') {
    const appended = [...baseKeys];
    for (const k of newKeys) {
      if (!appended.includes(k)) appended.push(k);
    }
    for (const k of currentKeys) {
      if (!appended.includes(k)) appended.push(k);
    }
    return appended;
  }

  // nearby strategy
  const result: string[] = [...baseKeys];
  const neighborPool = baseKeys.length ? baseKeys : [];

  for (const k of newKeys) {
    if (!neighborPool.length) {
      result.push(k);
      continue;
    }
    let bestIdx = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < neighborPool.length; i++) {
      const d = distance(k, neighborPool[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const anchor = neighborPool[bestIdx];
    const insertAt = Math.max(result.indexOf(anchor) + 1, 0);
    result.splice(insertAt, 0, k);
  }

  for (const k of currentKeys) {
    if (!result.includes(k)) result.push(k);
  }
  return result;
}

export function reorderFlatMap(
  initialBefore: FlatResourceMap,
  currentAfter: FlatResourceMap,
  createdKeys: string[],
  strategy: InsertOrderStrategy
): FlatResourceMap {
  const orderedKeys = orderKeys(Object.keys(initialBefore), Object.keys(currentAfter), createdKeys, strategy);
  const out: FlatResourceMap = {};
  for (const k of orderedKeys) {
    out[k] = currentAfter[k];
  }
  return out;
}

/**
 * Write a value at a dotted path, creating intermediate objects.
 *
 * Refuses when an ancestor already holds a value, or when the key itself names
 * an existing namespace: overwriting either one deletes translations.
 */
export function setNestedValue(target: Record<string, unknown>, key: string, value: string, separator = '.'): void {
  const segments = key.split(separator);
  if (segments.includes('__proto__')) {
    throw new Error(`Refusing to write key '${key}': '__proto__' is not a usable key segment.`);
  }
  let current: Record<string, unknown> = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      current[segment] = {};
    } else if (!isPlainObject(current[segment])) {
      throw new Error(
        `Cannot create '${key}': '${segments.slice(0, i + 1).join(separator)}' already holds a value. ` +
        'Writing here would delete it.'
      );
    }
    current = current[segment] as Record<string, unknown>;
  }
  const lastSegment = segments[segments.length - 1];
  if (isPlainObject(current[lastSegment])) {
    throw new Error(`Cannot set '${key}': it is a namespace holding ${Object.keys(current[lastSegment] as Record<string, unknown>).length} entr(ies). Writing a value here would delete them.`);
  }
  current[lastSegment] = value;
}

export function deleteNestedKey(target: Record<string, unknown>, key: string, separator = '.'): void {
  const segments = key.split(separator);
  let current: Record<string, unknown> | undefined = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (!isPlainObject(current?.[segment])) return;
    current = current?.[segment] as Record<string, unknown>;
  }
  if (isPlainObject(current)) delete current[segments[segments.length - 1]];
}
