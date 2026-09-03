import type { StructurePreference } from '../config';
import {
  flattenObject,
  flattenObjectPaths,
  unflattenObject,
  reorderFlatMap,
  reorderTopLevel,
  orderKeys,
  classifyResourceStructure,
  setNestedValue,
  deleteNestedKey,
  type FlatResourceMap,
  type ResourceStructure,
} from '../resource-utils';
import { loadJson, writeFilePretty } from './fs-write';
import type { Project, ResourceFile } from './resources';

/**
 * How a file is written back.
 * - flat / nested: the document is rebuilt in that shape.
 * - preserve: a mixed document, edited in place; nothing is converted.
 */
export type WriteStructure = 'flat' | 'nested' | 'preserve';

export type ResourceState = {
  file: ResourceFile;
  writeStructure: WriteStructure;
  json?: Record<string, unknown>;
  flatMap?: FlatResourceMap;
  initialFlat: FlatResourceMap;
  createdKeys: string[];
  /** Removals the caller asked for; the only keys allowed to disappear. */
  removedKeys: string[];
  changed: boolean;
  /** preserve mode: where a brand new key goes. */
  dominant?: 'flat' | 'nested';
  /** preserve mode: flat key -> the real property path holding it. */
  pathIndex?: Record<string, string[]>;
  /** preserve mode: top-level property order as loaded. */
  initialTopLevelKeys?: string[];
};

export type SetOutcome = 'created' | 'updated' | 'unchanged';

export type ResourceManager = {
  project: Project;
  /** Lazily loaded write state for one file; undefined when the file does not exist. */
  stateFor(locale: string, namespace: string): ResourceState | undefined;
  get(locale: string, fullKey: string): string | undefined;
  set(locale: string, fullKey: string, value: string): SetOutcome;
  delete(locale: string, fullKey: string): boolean;
  /** Full keys currently held for a locale, across its namespace files. */
  listKeys(locale: string): string[];
  changedFiles(): string[];
  /** Write every changed file (unless dryRun). Returns workspace-relative paths. */
  commit(dryRun: boolean): string[];
};

function isPlainObjectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Under 'auto' a MIXED file is preserved rather than converted. One nested
 * island used to make a file of thousands of flat keys "nested", and the
 * conversion that followed destroyed every key whose name was both a value and
 * a namespace.
 */
function determineWriteStructure(structure: ResourceStructure, preference: StructurePreference): WriteStructure {
  if (preference !== 'auto') return preference;
  if (structure.kind === 'mixed') return 'preserve';
  return structure.kind === 'nested' ? 'nested' : 'flat';
}

export function createResourceState(file: ResourceFile, root: string, preference: StructurePreference): ResourceState {
  const json = loadJson(file.filePath, root) as Record<string, unknown>;
  const structure = classifyResourceStructure(json);
  const writeStructure = determineWriteStructure(structure, preference);
  const base = { file, writeStructure, createdKeys: [] as string[], removedKeys: [] as string[], changed: false };

  if (writeStructure === 'flat') {
    const flatMap = flattenObject(json);
    return { ...base, flatMap: { ...flatMap }, initialFlat: { ...flatMap } };
  }
  if (writeStructure === 'nested') {
    return { ...base, json: { ...json }, initialFlat: flattenObject(json) };
  }
  const working = { ...json };
  return {
    ...base,
    json: working,
    initialFlat: flattenObject(working),
    dominant: structure.dominant,
    pathIndex: flattenObjectPaths(working),
    initialTopLevelKeys: Object.keys(working),
  };
}

function readNestedValue(target: Record<string, unknown> | undefined, key: string): string | undefined {
  let current: unknown = target;
  for (const segment of key.split('.')) {
    if (!isPlainObjectValue(current)) return undefined;
    current = current[segment];
  }
  return typeof current === 'undefined' || current === null || isPlainObjectValue(current) ? undefined : String(current);
}

// ─── preserve mode: edit a mixed document where its keys already are ─────────

function readAtPath(target: Record<string, unknown> | undefined, segments: string[]): string | undefined {
  let current: unknown = target;
  for (const segment of segments) {
    if (!isPlainObjectValue(current)) return undefined;
    current = current[segment];
  }
  return typeof current === 'undefined' || current === null || isPlainObjectValue(current) ? undefined : String(current);
}

function writeAtPath(target: Record<string, unknown>, segments: string[], value: string): void {
  let current = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      current[segment] = {};
    } else if (!isPlainObjectValue(current[segment])) {
      throw new Error(`Cannot write '${segments.join('.')}': '${segments.slice(0, i + 1).join('.')}' already holds a value.`);
    }
    current = current[segment] as Record<string, unknown>;
  }
  const last = segments[segments.length - 1];
  if (isPlainObjectValue(current[last])) {
    const size = Object.keys(current[last] as Record<string, unknown>).length;
    throw new Error(`Cannot write '${segments.join('.')}': it is a namespace holding ${size} entr(ies). Writing a value here would delete them.`);
  }
  current[last] = value;
}

function deleteAtPath(target: Record<string, unknown>, segments: string[]): void {
  let current: Record<string, unknown> = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const next = current[segments[i]];
    if (!isPlainObjectValue(next)) return;
    current = next;
  }
  delete current[segments[segments.length - 1]];
}

/** True when every segment of the path is free or already an object. */
function canPlaceNested(json: Record<string, unknown>, segments: string[]): boolean {
  let current: Record<string, unknown> = json;
  for (let i = 0; i < segments.length - 1; i++) {
    const next = current[segments[i]];
    if (typeof next === 'undefined') return true;
    if (!isPlainObjectValue(next)) return false;
    current = next;
  }
  return !isPlainObjectValue(current[segments[segments.length - 1]]);
}

/**
 * Where a brand new key goes in a mixed file: the file's dominant style, and a
 * literal dotted property whenever the nested path is blocked. A literal
 * property can never collide, so this branch cannot delete anything.
 */
function choosePreservePath(state: ResourceState, key: string): string[] {
  const json = state.json ?? {};
  const literalIsFree = !isPlainObjectValue(json[key]);
  const segments = key.split('.');
  if (state.dominant === 'nested') {
    if (canPlaceNested(json, segments)) return segments;
    if (literalIsFree) return [key];
  } else {
    if (literalIsFree) return [key];
    if (canPlaceNested(json, segments)) return segments;
  }
  throw new Error(`Cannot create '${key}' in ${state.file.relativePath}: the name is already a namespace and both placements would delete keys.`);
}

export function getValueFromState(state: ResourceState, key: string): string | undefined {
  if (state.writeStructure === 'flat') return state.flatMap?.[key];
  if (state.writeStructure === 'preserve') {
    const segments = state.pathIndex?.[key];
    return segments ? readAtPath(state.json, segments) : undefined;
  }
  return readNestedValue(state.json, key);
}

export function applyValueToState(state: ResourceState, key: string, value: string): SetOutcome {
  const before = getValueFromState(state, key);
  if (before === value) return 'unchanged';
  const outcome: SetOutcome = typeof before === 'undefined' ? 'created' : 'updated';

  if (state.writeStructure === 'flat') {
    if (!state.flatMap) state.flatMap = {};
    state.flatMap[key] = value;
  } else if (state.writeStructure === 'preserve') {
    if (!state.json) state.json = {};
    if (!state.pathIndex) state.pathIndex = flattenObjectPaths(state.json);
    const existing = state.pathIndex[key];
    if (existing) {
      writeAtPath(state.json, existing, value);
    } else {
      const target = choosePreservePath(state, key);
      writeAtPath(state.json, target, value);
      state.pathIndex[key] = target;
    }
  } else {
    if (!state.json) state.json = {};
    setNestedValue(state.json, key, value);
  }
  if (outcome === 'created' && !state.createdKeys.includes(key)) state.createdKeys.push(key);
  state.changed = true;
  return outcome;
}

export function deleteKeyFromState(state: ResourceState, key: string): boolean {
  if (typeof getValueFromState(state, key) === 'undefined') return false;
  if (state.writeStructure === 'flat') {
    delete state.flatMap![key];
  } else if (state.writeStructure === 'preserve') {
    const segments = state.pathIndex![key];
    deleteAtPath(state.json!, segments);
    delete state.pathIndex![key];
  } else {
    deleteNestedKey(state.json!, key);
  }
  if (!state.removedKeys.includes(key)) state.removedKeys.push(key);
  state.changed = true;
  return true;
}

export function listKeysFromState(state: ResourceState): string[] {
  if (state.writeStructure === 'flat') return Object.keys(state.flatMap ?? {});
  if (state.writeStructure === 'preserve') return Object.keys(state.pathIndex ?? {});
  return Object.keys(flattenObject(state.json ?? {}));
}

export function createResourceManager(project: Project): ResourceManager {
  const { root, config } = project;
  const states = new Map<string, ResourceState>();

  const stateFor = (locale: string, namespace: string): ResourceState | undefined => {
    const file = project.fileFor(locale, namespace);
    if (!file) return undefined;
    let state = states.get(file.filePath);
    if (!state) {
      state = createResourceState(file, root, config.structurePreference);
      states.set(file.filePath, state);
    }
    return state;
  };

  const requireState = (locale: string, fullKey: string): { state: ResourceState; key: string } => {
    if (!project.locales.includes(locale)) {
      throw new Error(`No resource file for locale '${locale}'. Available locales: ${project.locales.join(', ')}.`);
    }
    const { namespace, key } = project.splitKey(fullKey);
    const state = stateFor(locale, namespace);
    if (!state) {
      const label = namespace ? `namespace '${namespace}'` : 'this layout';
      throw new Error(`Locale '${locale}' has no file for ${label}. Create it first, then retry.`);
    }
    return { state, key };
  };

  const changedFiles = (): string[] => Array.from(states.values()).filter(s => s.changed).map(s => s.file.relativePath);

  const commit = (dryRun: boolean): string[] => {
    const files = changedFiles();
    if (dryRun) return files;
    for (const state of states.values()) {
      if (!state.changed) continue;
      // Only keys the caller asked to remove may disappear; the guard enforces it on disk.
      const guard = { allowRemovedKeys: state.removedKeys };
      if (state.writeStructure === 'flat') {
        const ordered = reorderFlatMap(state.initialFlat, state.flatMap ?? {}, state.createdKeys, config.insertOrderStrategy);
        writeFilePretty(state.file.filePath, ordered, root, guard);
      } else if (state.writeStructure === 'preserve') {
        const json = state.json ?? {};
        const currentTop = Object.keys(json);
        const initialTop = state.initialTopLevelKeys ?? [];
        const initialTopSet = new Set(initialTop);
        const createdTop = currentTop.filter(name => !initialTopSet.has(name));
        const orderedTop = orderKeys(initialTop, currentTop, createdTop, config.insertOrderStrategy);
        writeFilePretty(state.file.filePath, reorderTopLevel(json, orderedTop), root, guard);
      } else {
        const currentFlat = flattenObject(state.json ?? {});
        const orderedFlat = reorderFlatMap(state.initialFlat, currentFlat, state.createdKeys, config.insertOrderStrategy);
        writeFilePretty(state.file.filePath, unflattenObject(orderedFlat), root, guard);
      }
      state.changed = false;
    }
    return files;
  };

  return {
    project,
    stateFor,
    get(locale, fullKey) {
      if (!project.locales.includes(locale)) return undefined;
      let split: { namespace: string; key: string };
      try {
        split = project.splitKey(fullKey);
      } catch {
        return undefined;
      }
      const state = stateFor(locale, split.namespace);
      return state ? getValueFromState(state, split.key) : undefined;
    },
    set(locale, fullKey, value) {
      const { state, key } = requireState(locale, fullKey);
      return applyValueToState(state, key, value);
    },
    delete(locale, fullKey) {
      if (!project.locales.includes(locale)) return false;
      const { namespace, key } = project.splitKey(fullKey);
      const state = stateFor(locale, namespace);
      return state ? deleteKeyFromState(state, key) : false;
    },
    listKeys(locale) {
      const keys: string[] = [];
      for (const file of project.resources) {
        if (file.locale !== locale) continue;
        const state = stateFor(locale, file.namespace);
        if (!state) continue;
        for (const key of listKeysFromState(state)) keys.push(project.fullKey(file.namespace, key));
      }
      return keys;
    },
    changedFiles,
    commit,
  };
}
