#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import path from 'path';
import fs from 'fs';
import fg from 'fast-glob';
import ignore from 'ignore';
import net from 'net';
import { z } from 'zod';
import {
  readResourceFiles,
  getWorkspaceRoot,
  loadJson,
  setNestedValue,
  deleteNestedKey,
  writeFilePretty,
  findUntranslatedKeysInFile,
  findKeyReferences,
  ensureSafeWorkspacePath,
  type ResourceFile,
} from './i18nFs';
import {
  flattenObject,
  unflattenObject,
  reorderFlatMap,
  type FlatResourceMap,
} from './resourceUtils';
import {
  getEffectiveConfigFromEnv,
  buildCodeRegex,
  DEFAULT_CODE_GLOB,
  type StructurePreference,
  type InsertOrderStrategy,
} from './config';
import {
  limitItems,
  normalizeLimit,
  previewText,
  shouldDryRun,
  uniqueStrings,
  includesSearchText,
} from './toolUtils';

// ─── Types ────────────────────────────────────────────────────────────────────

type PresenceResult = Record<string, Record<string, boolean>>;
type UpsertOutcome = 'created' | 'updated' | 'unchanged' | 'error';

type ResourceState = {
  resource: ResourceFile;
  locale: string;
  localeFile: string;
  filePath: string;
  writeStructure: 'flat' | 'nested';
  json?: Record<string, unknown>;
  flatMap?: FlatResourceMap;
  initialFlat: FlatResourceMap;
  createdKeys: string[];
  changed: boolean;
};

type StructureSummary = {
  dryRun: boolean;
  changedFiles: string[];
  summary: { created: number; updated: number; unchanged: number; errors: number };
  results: Array<{
    localeFile: string;
    locale: string;
    key: string;
    result: UpsertOutcome;
    before?: string | null;
    after?: string | null;
    error?: string;
  }>;
};

type RenameSummary = {
  dryRun: boolean;
  changedFiles: string[];
  summary: { renamed: number; skipped: number; errors: number };
  results: Array<{
    localeFile: string;
    locale: string;
    from: string;
    to: string;
    result: 'renamed' | 'skipped' | 'error';
    before?: string | null;
    after?: string | null;
    error?: string;
  }>;
};

type NamespaceMoveSummary = {
  dryRun: boolean;
  changedFiles: string[];
  summary: { moved: number; skipped: number; errors: number };
  results: Array<{
    localeFile: string;
    locale: string;
    from: string;
    to: string;
    movedKeys: string[];
    result: 'moved' | 'skipped' | 'error';
    error?: string;
  }>;
};

type KeyLocaleMatch = {
  locale: string;
  localeFile: string;
  valuePreview?: string;
};

type SearchMatch = {
  key: string;
  locales: KeyLocaleMatch[];
};

type NamespaceEntry = {
  key: string;
  presentLocales: string[];
  missingLocales: string[];
  values?: Record<string, string | null>;
};

type MissingTranslation = {
  key: string;
  missingLocales: string[];
  presentLocales: string[];
  references?: Array<{ filePath: string; line: number; column: number }>;
};

type PlaceholderMismatch = {
  key: string;
  locale: string;
  missing: string[];
  extra: string[];
};

type UnusedKey = {
  key: string;
  locales: string[];
};

// ─── Logger ──────────────────────────────────────────────────────────────────

const safeStderr = (msg: string) => {
  try { process.stderr.write(msg + '\n'); } catch { /* ignore */ }
};

let mcpLogger: (msg: string) => void = safeStderr;

// ─── Locale utilities ────────────────────────────────────────────────────────

export function normalizeLocaleTag(input: string): string {
  if (!input) return '';
  const trimmed = input.trim();
  const withoutExt = trimmed.toLowerCase().endsWith('.json') ? trimmed.slice(0, -5) : trimmed;
  if (!withoutExt) return '';
  const segments = withoutExt.split(/[-_]/).filter(Boolean);
  if (!segments.length) return '';
  return segments
    .map((segment, index) => {
      if (index === 0) return segment.toLowerCase();
      if (segment.length === 2) return segment.toUpperCase();
      if (segment.length === 4) return segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase();
      return segment;
    })
    .join('-');
}

export function describeLocale(tag: string): string | undefined {
  const DisplayNames = (Intl as unknown as { DisplayNames?: typeof Intl.DisplayNames }).DisplayNames;
  if (!DisplayNames) return undefined;
  try {
    const segments = tag.split('-');
    const language = segments[0];
    const region = segments.find(seg => seg.length === 2 && seg === seg.toUpperCase());
    const script = segments.find(seg => seg.length === 4);
    const languageDn = new DisplayNames(['en'], { type: 'language' });
    const regionDn = new DisplayNames(['en'], { type: 'region' });
    const scriptDn = new DisplayNames(['en'], { type: 'script' });
    const languageName = languageDn.of(language) || language;
    const scriptName = script ? scriptDn.of(script) : undefined;
    const regionName = region ? regionDn.of(region) : undefined;
    if (regionName && scriptName) return `${languageName} (${scriptName} - ${regionName})`;
    if (regionName) return `${languageName} (${regionName})`;
    if (scriptName) return `${languageName} (${scriptName})`;
    return languageName;
  } catch { return undefined; }
}

// ─── Placeholder utilities ───────────────────────────────────────────────────

const PLACEHOLDER_BRACE = /\{\{\s*([\d\w.-]+)\s*\}\}/g;
const PLACEHOLDER_CURVY = /\{\s*([\d\w.-]+)\s*\}/g;

export function extractPlaceholders(value: string | undefined): Set<string> {
  const placeholders = new Set<string>();
  if (!value) return placeholders;
  const addMatches = (regex: RegExp) => {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(value)) !== null) {
      const found = match[1];
      if (found) placeholders.add(found);
    }
  };
  addMatches(PLACEHOLDER_BRACE);
  addMatches(PLACEHOLDER_CURVY);
  return placeholders;
}

// ─── Resource state management ───────────────────────────────────────────────

export function relativeToWorkspace(filePath: string, workspaceDir?: string): string {
  const workspaceRoot = getWorkspaceRoot(workspaceDir);
  const relative = path.relative(workspaceRoot, filePath);
  return !relative || relative.startsWith('..') ? filePath : relative;
}

function determineWriteStructure(resource: ResourceFile, preference: StructurePreference): 'flat' | 'nested' {
  if (preference === 'auto') return resource.isNested ? 'nested' : 'flat';
  return preference;
}

export function createResourceState(resource: ResourceFile, preference: StructurePreference, workspaceDir?: string): ResourceState {
  const locale = normalizeLocaleTag(resource.fileName);
  const localeFile = relativeToWorkspace(resource.filePath, workspaceDir);
  const writeStructure = determineWriteStructure(resource, preference);
  const json = loadJson(resource.filePath, workspaceDir) as Record<string, unknown>;

  if (writeStructure === 'flat') {
    const flatMap = flattenObject(json);
    return { resource, locale, localeFile, filePath: resource.filePath, writeStructure, flatMap: { ...flatMap }, initialFlat: { ...flatMap }, createdKeys: [], changed: false };
  }
  return { resource, locale, localeFile, filePath: resource.filePath, writeStructure, json: { ...json }, initialFlat: flattenObject(json), createdKeys: [], changed: false };
}

function readNestedValue(target: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!target) return undefined;
  let current: unknown = target;
  for (const segment of key.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === 'undefined' || current === null ? undefined : String(current);
}

export function getValueFromState(state: ResourceState, key: string): string | undefined {
  return state.writeStructure === 'flat' ? state.flatMap?.[key] : readNestedValue(state.json, key);
}

export function applyValueToState(state: ResourceState, key: string, value: string): void {
  if (state.writeStructure === 'flat') {
    if (!state.flatMap) state.flatMap = {};
    if (typeof state.flatMap[key] === 'undefined' && !state.createdKeys.includes(key)) state.createdKeys.push(key);
    state.flatMap[key] = value;
  } else {
    if (!state.json) state.json = {};
    if (typeof readNestedValue(state.json, key) === 'undefined' && !state.createdKeys.includes(key)) state.createdKeys.push(key);
    setNestedValue(state.json, key, value);
  }
  state.changed = true;
}

export function deleteKeyFromState(state: ResourceState, key: string): boolean {
  if (state.writeStructure === 'flat') {
    if (state.flatMap && Object.prototype.hasOwnProperty.call(state.flatMap, key)) {
      delete state.flatMap[key];
      state.changed = true;
      return true;
    }
    return false;
  }
  const before = readNestedValue(state.json, key);
  if (typeof before === 'undefined') return false;
  if (state.json) { deleteNestedKey(state.json, key); state.changed = true; return true; }
  return false;
}

export function listKeysFromState(state: ResourceState): string[] {
  return state.writeStructure === 'flat'
    ? Object.keys(state.flatMap ?? {})
    : Object.keys(flattenObject(state.json ?? {}));
}

export function createResourceManager(
  resources: ResourceFile[],
  preference: StructurePreference,
  insertOrder: InsertOrderStrategy,
  workspaceDir?: string
) {
  const localeMap = new Map<string, ResourceFile>();
  for (const resource of resources) localeMap.set(normalizeLocaleTag(resource.fileName), resource);
  const stateMap = new Map<string, ResourceState>();

  const getState = (locale: string): ResourceState | undefined => {
    const resource = localeMap.get(locale);
    if (!resource) return undefined;
    let state = stateMap.get(resource.filePath);
    if (!state) {
      state = createResourceState(resource, preference, workspaceDir);
      stateMap.set(resource.filePath, state);
    }
    return state;
  };

  const changedFiles = () => Array.from(stateMap.values())
    .filter(state => state.changed)
    .map(state => state.localeFile);

  const commit = (dryRun: boolean): string[] => {
    const files = changedFiles();
    if (dryRun) return files;
    for (const state of stateMap.values()) {
      if (!state.changed) continue;
      if (state.writeStructure === 'flat') {
        const ordered = reorderFlatMap(state.initialFlat, state.flatMap ?? {}, state.createdKeys, insertOrder);
        writeFilePretty(state.filePath, ordered, workspaceDir);
      } else {
        const currentFlat = flattenObject(state.json ?? {});
        const orderedFlat = reorderFlatMap(state.initialFlat, currentFlat, state.createdKeys, insertOrder);
        writeFilePretty(state.filePath, unflattenObject(orderedFlat), workspaceDir);
      }
      state.changed = false;
    }
    return files;
  };

  return { preference, localeMap, states: stateMap, getState, changedFiles, commit };
}

// ─── Workspace key collector ─────────────────────────────────────────────────

export async function collectWorkspaceKeys(excludePaths: Set<string>, workspaceDir?: string): Promise<Set<string>> {
  const envConfig = getEffectiveConfigFromEnv(process.env);
  const workspaceRoot = getWorkspaceRoot(workspaceDir);
  const codeFiles = await fg(envConfig.codeGlob || DEFAULT_CODE_GLOB, {
    cwd: workspaceRoot,
    absolute: true,
    onlyFiles: true,
    dot: false,
    ignore: envConfig.ignoreGlobs,
    followSymbolicLinks: false,
    suppressErrors: true,
    throwErrorOnBrokenSymbolicLink: false,
  });

  let ig = ignore();
  try {
    const content = fs.readFileSync(path.join(workspaceRoot, '.gitignore'), 'utf8');
    ig = ignore().add(content);
  } catch { /* no .gitignore */ }

  const regex = buildCodeRegex(process.env.I18N_CODE_REGEX);
  const keys = new Set<string>();

  for (const filePath of codeFiles) {
    if (excludePaths.has(path.normalize(filePath))) continue;
    const relative = path.relative(workspaceRoot, filePath);
    if (relative && ig.ignores(relative)) continue;
    let content: string;
    try { content = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const key = (match.groups && (match.groups as Record<string, string>).key) || match[0];
      if (key) keys.add(key);
    }
  }
  return keys;
}

// ─── Resource loader with error ──────────────────────────────────────────────

export async function ensureResources(workspaceDir?: string): Promise<ResourceFile[]> {
  const resources = await readResourceFiles(undefined, workspaceDir);
  if (resources.length === 0) {
    const root = getWorkspaceRoot(workspaceDir);
    const cfg = getEffectiveConfigFromEnv(process.env);
    throw new Error(`No i18n resource files found. Adjust WORKSPACE_ROOT or I18N_GLOB. Details: root='${root}', I18N_GLOB='${cfg.resourceGlob}'`);
  }
  try {
    const preview = resources.slice(0, 5).map(r => r.fileName).join(', ');
    mcpLogger(`[i18n-codelens MCP] resources detected: count=${resources.length}, sample=[${preview}]`);
  } catch { /* ignore */ }
  return resources;
}

function buildLocaleMap(resources: ResourceFile[]): Map<string, ResourceFile> {
  return new Map(resources.map(res => [normalizeLocaleTag(res.fileName), res] as const));
}

function selectLocales(resources: ResourceFile[], locales?: string[]) {
  const localeMap = buildLocaleMap(resources);
  const requestedLocales = locales && locales.length
    ? uniqueStrings(locales.map(normalizeLocaleTag))
    : Array.from(localeMap.keys());
  const selectedLocales = requestedLocales.filter(locale => localeMap.has(locale));
  const missingRequestedLocales = requestedLocales.filter(locale => !localeMap.has(locale));
  return { localeMap, selectedLocales, missingRequestedLocales };
}

function sortedKeys(values: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(values))).sort((a, b) => a.localeCompare(b));
}

function relativizeReferences<T extends { filePath: string; line: number; column: number }>(refs: T[], workspaceDir?: string): T[] {
  return refs.map(ref => ({ ...ref, filePath: relativeToWorkspace(ref.filePath, workspaceDir) }));
}

function buildMissingAgainstBase(
  resources: ResourceFile[],
  baseLocale: string,
  selectedLocales: string[]
): MissingTranslation[] {
  const localeMap = buildLocaleMap(resources);
  const baseResource = localeMap.get(baseLocale);
  if (!baseResource) throw new Error(`Locale '${baseLocale}' not found. Call i18n_list_locales for the current list.`);
  const baseKeys = Object.keys(baseResource.keyValuePairs);
  const missing: MissingTranslation[] = [];

  for (const key of baseKeys) {
    const missingLocales: string[] = [];
    const presentLocales: string[] = [];
    for (const locale of selectedLocales) {
      const resource = localeMap.get(locale);
      if (!resource) continue;
      if (Object.prototype.hasOwnProperty.call(resource.keyValuePairs, key)) presentLocales.push(locale);
      else missingLocales.push(locale);
    }
    if (missingLocales.length) missing.push({ key, missingLocales, presentLocales });
  }
  return missing;
}

function buildPlaceholderMismatches(
  resources: ResourceFile[],
  baseLocale: string,
  selectedLocales: string[],
  keys?: string[]
): PlaceholderMismatch[] {
  const localeMap = buildLocaleMap(resources);
  const baseResource = localeMap.get(baseLocale);
  if (!baseResource) throw new Error(`Locale '${baseLocale}' not found. Call i18n_list_locales for the current list.`);
  const keysToCheck = keys && keys.length ? keys : Object.keys(baseResource.keyValuePairs);
  const mismatches: PlaceholderMismatch[] = [];

  for (const key of keysToCheck) {
    const baseValue = baseResource.keyValuePairs[key];
    if (typeof baseValue === 'undefined') continue;
    const basePlaceholders = extractPlaceholders(baseValue);
    for (const locale of selectedLocales) {
      if (locale === baseLocale) continue;
      const compareValue = localeMap.get(locale)?.keyValuePairs[key];
      if (typeof compareValue === 'undefined') continue;
      const comparePlaceholders = extractPlaceholders(compareValue);
      const missing = Array.from(basePlaceholders).filter(ph => !comparePlaceholders.has(ph));
      const extra = Array.from(comparePlaceholders).filter(ph => !basePlaceholders.has(ph));
      if (missing.length || extra.length) mismatches.push({ key, locale, missing, extra });
    }
  }
  return mismatches;
}

async function buildUnusedKeys(resources: ResourceFile[], selectedLocales: string[], workspaceDir?: string): Promise<UnusedKey[]> {
  const resourcePaths = new Set(resources.map(res => path.normalize(res.filePath)));
  const keysInCode = await collectWorkspaceKeys(resourcePaths, workspaceDir);
  const localeMap = buildLocaleMap(resources);
  const keyLocales = new Map<string, string[]>();

  for (const locale of selectedLocales) {
    const resource = localeMap.get(locale);
    if (!resource) continue;
    for (const key of Object.keys(resource.keyValuePairs)) {
      if (keysInCode.has(key)) continue;
      const locales = keyLocales.get(key) ?? [];
      locales.push(locale);
      keyLocales.set(key, locales);
    }
  }

  return Array.from(keyLocales.entries())
    .map(([key, locales]) => ({ key, locales }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

async function buildCodeMissingKeys(resources: ResourceFile[], selectedLocales: string[], workspaceDir?: string): Promise<MissingTranslation[]> {
  const resourcePaths = new Set(resources.map(res => path.normalize(res.filePath)));
  const keysInCode = await collectWorkspaceKeys(resourcePaths, workspaceDir);
  const localeMap = buildLocaleMap(resources);
  const missing: MissingTranslation[] = [];

  for (const key of keysInCode) {
    const missingLocales: string[] = [];
    const presentLocales: string[] = [];
    for (const locale of selectedLocales) {
      const resource = localeMap.get(locale);
      if (!resource) continue;
      if (Object.prototype.hasOwnProperty.call(resource.keyValuePairs, key)) presentLocales.push(locale);
      else missingLocales.push(locale);
    }
    if (missingLocales.length) missing.push({ key, missingLocales, presentLocales });
  }
  return missing.sort((a, b) => a.key.localeCompare(b.key));
}

// ─── Tool implementations ────────────────────────────────────────────────────

export async function toolProjectInfo(args: { workspaceDir?: string } = {}) {
  const workspaceDir = resolveWorkspaceDir(args.workspaceDir);
  const workspaceRoot = getWorkspaceRoot(workspaceDir);
  const cfg = getEffectiveConfigFromEnv(process.env);
  const resources = await ensureResources(workspaceDir);
  const allKeys = new Set(resources.flatMap(res => Object.keys(res.keyValuePairs)));
  const locales = resources.map(res => ({
    locale: normalizeLocaleTag(res.fileName),
    localeFile: relativeToWorkspace(res.filePath, workspaceDir),
    isNested: res.isNested,
    keyCount: Object.keys(res.keyValuePairs).length,
  }));

  return {
    workspaceRoot,
    config: {
      resourceGlob: cfg.resourceGlob,
      codeGlob: cfg.codeGlob,
      ignoreGlobs: cfg.ignoreGlobs,
      structurePreference: cfg.structurePreference,
      insertOrderStrategy: cfg.insertOrderStrategy,
      codeRegex: process.env.I18N_CODE_REGEX ? 'custom' : 'default',
    },
    totals: {
      localeCount: locales.length,
      uniqueKeyCount: allKeys.size,
      resourceKeyCount: resources.reduce((sum, res) => sum + Object.keys(res.keyValuePairs).length, 0),
    },
    locales,
  };
}

export async function toolSearchKeys(args: {
  query?: string;
  keyPrefix?: string;
  searchIn?: 'keys' | 'values' | 'both';
  locales?: string[];
  caseSensitive?: boolean;
  includeValues?: boolean;
  maxValueChars?: number;
  limit?: number;
  workspaceDir?: string;
}) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const keyPrefix = typeof args.keyPrefix === 'string' ? args.keyPrefix.trim() : '';
  if (!query && !keyPrefix) throw new Error('query or keyPrefix is required');
  const searchIn = args.searchIn || 'both';
  const includeValues = Boolean(args.includeValues);
  const limit = normalizeLimit(args.limit);
  const maxValueChars = normalizeLimit(args.maxValueChars, 160, 1000);
  const workspaceDir = resolveWorkspaceDir(args.workspaceDir);
  const resources = await ensureResources(workspaceDir);
  const { selectedLocales, missingRequestedLocales } = selectLocales(resources, args.locales);
  const matches = new Map<string, SearchMatch>();

  for (const resource of resources) {
    const locale = normalizeLocaleTag(resource.fileName);
    if (!selectedLocales.includes(locale)) continue;
    for (const [key, value] of Object.entries(resource.keyValuePairs)) {
      if (keyPrefix && !key.startsWith(keyPrefix)) continue;
      const keyMatches = searchIn !== 'values' && includesSearchText(key, query, Boolean(args.caseSensitive));
      const valueMatches = searchIn !== 'keys' && includesSearchText(value, query, Boolean(args.caseSensitive));
      if (query && !keyMatches && !valueMatches) continue;
      const match = matches.get(key) ?? { key, locales: [] };
      const localeMatch: KeyLocaleMatch = {
        locale,
        localeFile: relativeToWorkspace(resource.filePath, workspaceDir),
      };
      if (includeValues) localeMatch.valuePreview = previewText(value, maxValueChars);
      match.locales.push(localeMatch);
      matches.set(key, match);
    }
  }

  const allMatches = Array.from(matches.values()).sort((a, b) => a.key.localeCompare(b.key));
  const limited = limitItems(allMatches, limit);
  return {
    query,
    keyPrefix,
    searchIn,
    locales: selectedLocales,
    missingRequestedLocales,
    totalMatches: allMatches.length,
    limit: limited.limit,
    truncated: limited.truncated,
    matches: limited.items,
  };
}

export async function toolGetNamespace(args: {
  prefix: string;
  locales?: string[];
  includeValues?: boolean;
  maxValueChars?: number;
  limit?: number;
  workspaceDir?: string;
}) {
  const prefixRaw = typeof args.prefix === 'string' ? args.prefix.trim() : '';
  if (!prefixRaw) throw new Error('prefix is required');
  const prefix = prefixRaw.endsWith('.') ? prefixRaw : `${prefixRaw}.`;
  const includeValues = Boolean(args.includeValues);
  const limit = normalizeLimit(args.limit);
  const maxValueChars = normalizeLimit(args.maxValueChars, 160, 1000);
  const workspaceDir = resolveWorkspaceDir(args.workspaceDir);
  const resources = await ensureResources(workspaceDir);
  const { localeMap, selectedLocales, missingRequestedLocales } = selectLocales(resources, args.locales);
  const keys = sortedKeys(resources.flatMap(res => Object.keys(res.keyValuePairs).filter(key => key.startsWith(prefix))));

  const entries: NamespaceEntry[] = keys.map(key => {
    const presentLocales: string[] = [];
    const missingLocales: string[] = [];
    const values: Record<string, string | null> = {};
    for (const locale of selectedLocales) {
      const value = localeMap.get(locale)?.keyValuePairs[key];
      if (typeof value === 'undefined') {
        missingLocales.push(locale);
        if (includeValues) values[locale] = null;
      } else {
        presentLocales.push(locale);
        if (includeValues) values[locale] = previewText(value, maxValueChars);
      }
    }
    const entry: NamespaceEntry = { key, presentLocales, missingLocales };
    if (includeValues) entry.values = values;
    return entry;
  });

  const limited = limitItems(entries, limit);
  return {
    prefix,
    locales: selectedLocales,
    missingRequestedLocales,
    totalKeys: entries.length,
    limit: limited.limit,
    truncated: limited.truncated,
    keys: limited.items,
  };
}

export async function toolUnusedKeys(args: { locales?: string[]; limit?: number; workspaceDir?: string } = {}) {
  const workspaceDir = resolveWorkspaceDir(args.workspaceDir);
  const limit = normalizeLimit(args.limit);
  const resources = await ensureResources(workspaceDir);
  const { selectedLocales, missingRequestedLocales } = selectLocales(resources, args.locales);
  const unused = await buildUnusedKeys(resources, selectedLocales, workspaceDir);
  const limited = limitItems(unused, limit);
  return {
    locales: selectedLocales,
    missingRequestedLocales,
    totalUnused: unused.length,
    limit: limited.limit,
    truncated: limited.truncated,
    unused: limited.items,
  };
}

export async function toolAudit(args: { baseLocale?: string; locales?: string[]; limit?: number; workspaceDir?: string } = {}) {
  const workspaceDir = resolveWorkspaceDir(args.workspaceDir);
  const limit = normalizeLimit(args.limit);
  const resources = await ensureResources(workspaceDir);
  const { selectedLocales, missingRequestedLocales } = selectLocales(resources, args.locales);
  if (!selectedLocales.length) throw new Error('No matching locales selected');
  const baseLocale = normalizeLocaleTag(args.baseLocale || selectedLocales[0]);
  if (!selectedLocales.includes(baseLocale)) selectedLocales.unshift(baseLocale);

  const missingAgainstBase = buildMissingAgainstBase(resources, baseLocale, selectedLocales);
  const placeholderMismatches = buildPlaceholderMismatches(resources, baseLocale, selectedLocales);
  const codeMissingKeys = await buildCodeMissingKeys(resources, selectedLocales, workspaceDir);
  const unusedKeys = await buildUnusedKeys(resources, selectedLocales, workspaceDir);
  const limitedBaseMissing = limitItems(missingAgainstBase, limit);
  const limitedPlaceholderMismatches = limitItems(placeholderMismatches, limit);
  const limitedCodeMissing = limitItems(codeMissingKeys, limit);
  const limitedUnused = limitItems(unusedKeys, limit);

  return {
    baseLocale,
    locales: selectedLocales,
    missingRequestedLocales,
    summary: {
      localeCount: selectedLocales.length,
      missingAgainstBase: missingAgainstBase.length,
      placeholderMismatches: placeholderMismatches.length,
      codeMissingKeys: codeMissingKeys.length,
      unusedKeys: unusedKeys.length,
    },
    limit,
    truncated: limitedBaseMissing.truncated || limitedPlaceholderMismatches.truncated || limitedCodeMissing.truncated || limitedUnused.truncated,
    missingAgainstBase: limitedBaseMissing.items,
    placeholderMismatches: limitedPlaceholderMismatches.items,
    codeMissingKeys: limitedCodeMissing.items,
    unusedKeys: limitedUnused.items,
  };
}

export async function toolFormatResources(args: {
  locales?: string[];
  sortKeys?: boolean;
  dryRun?: boolean;
  workspaceDir?: string;
} = {}) {
  const workspaceDir = resolveWorkspaceDir(args.workspaceDir);
  const dryRun = shouldDryRun(args.dryRun);
  const sortKeys = args.sortKeys !== false;
  const resources = await ensureResources(workspaceDir);
  const { selectedLocales, missingRequestedLocales } = selectLocales(resources, args.locales);
  const results: Array<{ locale: string; localeFile: string; changed: boolean; error?: string }> = [];
  const changedFiles: string[] = [];

  for (const resource of resources) {
    const locale = normalizeLocaleTag(resource.fileName);
    if (!selectedLocales.includes(locale)) continue;
    const localeFile = relativeToWorkspace(resource.filePath, workspaceDir);
    try {
      const target = ensureSafeWorkspacePath(resource.filePath, workspaceDir);
      const raw = fs.readFileSync(target, 'utf8');
      const json = loadJson(target, workspaceDir) as Record<string, unknown>;
      let nextJson: Record<string, unknown>;
      if (sortKeys) {
        const flat = flattenObject(json);
        const ordered: FlatResourceMap = {};
        for (const key of Object.keys(flat).sort((a, b) => a.localeCompare(b))) ordered[key] = flat[key];
        nextJson = resource.isNested ? unflattenObject(ordered) : ordered;
      } else {
        nextJson = json;
      }
      const nextRaw = JSON.stringify(nextJson, null, 2) + '\n';
      const changed = raw !== nextRaw;
      if (changed) {
        changedFiles.push(localeFile);
        if (!dryRun) writeFilePretty(target, nextJson, workspaceDir);
      }
      results.push({ locale, localeFile, changed });
    } catch (err: unknown) {
      results.push({ locale, localeFile, changed: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    dryRun,
    sortKeys,
    changedFiles,
    missingRequestedLocales,
    summary: {
      checked: results.length,
      changed: results.filter(r => r.changed).length,
      unchanged: results.filter(r => !r.changed && !r.error).length,
      errors: results.filter(r => r.error).length,
    },
    results,
  };
}

export async function toolCheckKeys(args: { keys?: string[]; workspaceDir?: string }): Promise<PresenceResult> {
  const keys = Array.isArray(args.keys) ? args.keys : [];
  const workspaceDir = resolveWorkspaceDir(args.workspaceDir);
  const resources = await ensureResources(workspaceDir);
  const out: PresenceResult = {};
  for (const key of keys) {
    const perLang: Record<string, boolean> = {};
    for (const res of resources) {
      const locale = normalizeLocaleTag(res.fileName);
      if (key.endsWith('.')) {
        perLang[locale] = Object.keys(res.keyValuePairs).some(k => k.startsWith(key));
      } else {
        perLang[locale] = Object.prototype.hasOwnProperty.call(res.keyValuePairs, key);
      }
    }
    out[key] = perLang;
  }
  return out;
}

export async function toolUntranslatedKeysOnPage(args: { filePath: string; workspaceDir?: string }): Promise<string[]> {
  const workspaceDir = resolveWorkspaceDir(args.workspaceDir);
  const abs = path.isAbsolute(args.filePath) ? args.filePath : path.join(getWorkspaceRoot(workspaceDir), args.filePath);
  const safeAbs = ensureSafeWorkspacePath(abs, workspaceDir);
  if (!fs.existsSync(safeAbs)) throw new Error(`File not found: ${safeAbs}`);
  const resources = await ensureResources(workspaceDir);
  const usedKeys = findUntranslatedKeysInFile(safeAbs, []);
  return usedKeys.filter(k => resources.some(r => !Object.prototype.hasOwnProperty.call(r.keyValuePairs, k)));
}

export async function toolUpsertTranslations(args: {
  entries?: Array<{ key: string; values: Record<string, string | undefined> }>;
  dryRun?: boolean;
  workspaceDir?: string;
}): Promise<StructureSummary> {
  const entries = Array.isArray(args.entries) ? args.entries : [];
  if (!entries.length) throw new Error('entries array must contain at least one item');

  const workspaceDir = resolveWorkspaceDir(args.workspaceDir);
  const resources = await ensureResources(workspaceDir);
  const { structurePreference, insertOrderStrategy } = getEffectiveConfigFromEnv(process.env);
  const manager = createResourceManager(resources, structurePreference, insertOrderStrategy, workspaceDir);
  const dryRun = shouldDryRun(args.dryRun);
  const results: StructureSummary['results'] = [];
  const summary: StructureSummary['summary'] = { created: 0, updated: 0, unchanged: 0, errors: 0 };

  for (const entry of entries) {
    if (!entry || typeof entry.key !== 'string' || !entry.key.trim()) {
      summary.errors += 1;
      results.push({ localeFile: 'n/a', locale: 'n/a', key: String(entry?.key ?? ''), result: 'error', error: 'Invalid key specified' });
      continue;
    }
    const key = entry.key.trim();
    const values = entry.values || {};

    for (const rawLocaleKey of Object.keys(values)) {
      const normalizedLocale = normalizeLocaleTag(rawLocaleKey);
      if (!normalizedLocale) {
        summary.errors += 1;
        results.push({ localeFile: rawLocaleKey, locale: rawLocaleKey, key, result: 'error', error: `Invalid locale identifier: ${rawLocaleKey}` });
        continue;
      }
      const state = manager.getState(normalizedLocale);
      if (!state) {
        summary.errors += 1;
        results.push({ localeFile: rawLocaleKey, locale: normalizedLocale, key, result: 'error', error: `No resource file found for locale '${normalizedLocale}'. Call i18n_list_locales to review available files.` });
        continue;
      }
      const nextValueRaw = values[rawLocaleKey];
      if (typeof nextValueRaw === 'undefined') continue;
      const nextValue = String(nextValueRaw);
      const before = getValueFromState(state, key);
      let outcome: UpsertOutcome;
      if (typeof before === 'undefined') {
        outcome = 'created';
        applyValueToState(state, key, nextValue);
      } else if (before === nextValue) {
        outcome = 'unchanged';
      } else {
        outcome = 'updated';
        applyValueToState(state, key, nextValue);
      }
      summary[outcome] += 1;
      results.push({
        localeFile: relativeToWorkspace(state.filePath, workspaceDir),
        locale: state.locale,
        key,
        result: outcome,
        before: typeof before === 'undefined' ? null : before,
        after: outcome === 'unchanged' ? before ?? null : nextValue,
      });
    }
  }
  const changedFiles = manager.commit(dryRun);
  return { dryRun, changedFiles, summary, results };
}

export async function toolDeleteKey(args: { key: string; locales?: string[]; dryRun?: boolean; workspaceDir?: string }): Promise<{ dryRun: boolean; changedFiles: string[]; deletedFrom: string[] }> {
  const key = typeof args.key === 'string' ? args.key.trim() : '';
  if (!key) throw new Error('key is required');
  const workspaceDir = resolveWorkspaceDir(args.workspaceDir);
  const resources = await ensureResources(workspaceDir);
  const { structurePreference, insertOrderStrategy } = getEffectiveConfigFromEnv(process.env);
  const manager = createResourceManager(resources, structurePreference, insertOrderStrategy, workspaceDir);
  const dryRun = shouldDryRun(args.dryRun);
  const filter = new Set((args.locales || []).map(normalizeLocaleTag).filter(Boolean));
  const deletedFrom: string[] = [];

  for (const locale of manager.localeMap.keys()) {
    if (filter.size && !filter.has(locale)) continue;
    const state = manager.getState(locale);
    if (!state) continue;
    if (typeof getValueFromState(state, key) === 'undefined') continue;
    if (deleteKeyFromState(state, key)) deletedFrom.push(state.localeFile);
  }
  const changedFiles = manager.commit(dryRun);
  return { dryRun, changedFiles, deletedFrom };
}

export async function toolListLocales(args: { workspaceDir?: string } = {}) {
  const workspaceDir = resolveWorkspaceDir(args.workspaceDir);
  const resources = await ensureResources(workspaceDir);
  const locales = resources.map(res => ({
    locale: normalizeLocaleTag(res.fileName),
    localeFile: relativeToWorkspace(res.filePath, workspaceDir),
    description: describeLocale(normalizeLocaleTag(res.fileName)),
    isNested: res.isNested,
    keyCount: Object.keys(res.keyValuePairs).length,
  }));
  return { languages: locales.map(l => l.locale), locales };
}

export async function toolGetTranslations(args: { keys?: string[]; locales?: string[]; workspaceDir?: string }) {
  const keys = Array.isArray(args.keys) ? args.keys.map(k => k.trim()).filter(Boolean) : [];
  if (!keys.length) throw new Error('keys array must contain at least one key');
  const workspaceDir = resolveWorkspaceDir(args.workspaceDir);
  const resources = await ensureResources(workspaceDir);
  const requestedLocales = (args.locales || resources.map(r => r.fileName)).map(normalizeLocaleTag).filter(Boolean);
  const localeMap = new Map(resources.map(res => [normalizeLocaleTag(res.fileName), res] as const));
  const effectiveLocales = Array.from(new Set(requestedLocales)).filter(l => localeMap.has(l));
  const missingRequestedLocales = Array.from(new Set(requestedLocales)).filter(l => !localeMap.has(l));
  if (!effectiveLocales.length) throw new Error('None of the requested locales are available. Call i18n_list_locales for the current list.');
  const translations = keys.map(key => {
    const values: Record<string, string | null> = {};
    for (const locale of effectiveLocales) {
      const value = localeMap.get(locale)?.keyValuePairs[key];
      values[locale] = typeof value === 'undefined' ? null : value;
    }
    return { key, values };
  });
  return { locales: effectiveLocales, missingRequestedLocales, translations };
}

export async function toolDiffLocales(args: { base: string; compare: string[]; limit?: number; workspaceDir?: string }) {
  const baseLocale = normalizeLocaleTag(args.base);
  if (!baseLocale) throw new Error('base locale is required');
  const compareLocales = (args.compare || []).map(normalizeLocaleTag).filter(Boolean);
  if (!compareLocales.length) throw new Error('compare array must contain at least one locale');
  const limit = normalizeLimit(args.limit);
  const workspaceDir = resolveWorkspaceDir(args.workspaceDir);
  const resources = await ensureResources(workspaceDir);
  const localeMap = new Map(resources.map(res => [normalizeLocaleTag(res.fileName), res] as const));
  const baseResource = localeMap.get(baseLocale);
  if (!baseResource) throw new Error(`Locale '${baseLocale}' not found. Call i18n_list_locales for the current list.`);
  const baseKeys = new Set(Object.keys(baseResource.keyValuePairs));
  const comparisons = compareLocales.map(locale => {
    const resource = localeMap.get(locale);
    if (!resource) {
      const missing = Array.from(baseKeys);
      return {
        locale,
        missing: missing.slice(0, limit),
        extra: [],
        placeholderMismatches: [],
        totals: { missing: missing.length, extra: 0, placeholderMismatches: 0 },
        truncated: missing.length > limit,
      };
    }
    const compareKeys = new Set(Object.keys(resource.keyValuePairs));
    const missing = Array.from(baseKeys).filter(k => !compareKeys.has(k));
    const extra = Array.from(compareKeys).filter(k => !baseKeys.has(k));
    const placeholderMismatches: Array<{ key: string; missing: string[]; extra: string[] }> = [];
    for (const key of baseKeys) {
      if (!compareKeys.has(key)) continue;
      const basePlaceholders = extractPlaceholders(baseResource.keyValuePairs[key]);
      const comparePlaceholders = extractPlaceholders(resource.keyValuePairs[key]);
      const missingPh = Array.from(basePlaceholders).filter(ph => !comparePlaceholders.has(ph));
      const extraPh = Array.from(comparePlaceholders).filter(ph => !basePlaceholders.has(ph));
      if (missingPh.length || extraPh.length) placeholderMismatches.push({ key, missing: missingPh, extra: extraPh });
    }
    const truncated = missing.length > limit || extra.length > limit || placeholderMismatches.length > limit;
    return {
      locale,
      missing: missing.slice(0, limit),
      extra: extra.slice(0, limit),
      placeholderMismatches: placeholderMismatches.slice(0, limit),
      totals: { missing: missing.length, extra: extra.length, placeholderMismatches: placeholderMismatches.length },
      truncated,
    };
  });
  return { base: baseLocale, limit, comparisons };
}

export async function toolScanWorkspaceMissing(args: { limit?: number; includeReferences?: boolean; workspaceDir?: string } = {}) {
  const workspaceDir = resolveWorkspaceDir(args.workspaceDir);
  const limit = normalizeLimit(args.limit);
  const includeReferences = args.includeReferences !== false;
  const resources = await ensureResources(workspaceDir);
  const resourcePaths = new Set(resources.map(res => path.normalize(res.filePath)));
  const keysInCode = await collectWorkspaceKeys(resourcePaths, workspaceDir);
  const localeMap = new Map(resources.map(res => [normalizeLocaleTag(res.fileName), res] as const));
  const missing: MissingTranslation[] = [];

  for (const key of keysInCode) {
    const missingLocales: string[] = [];
    const presentLocales: string[] = [];
    for (const [locale, resource] of localeMap.entries()) {
      if (Object.prototype.hasOwnProperty.call(resource.keyValuePairs, key)) presentLocales.push(locale);
      else missingLocales.push(locale);
    }
    if (missingLocales.length) missing.push({ key, missingLocales, presentLocales, references: [] });
  }

  if (includeReferences && missing.length) {
    const referenceSummary = await findKeyReferences(missing.map(i => i.key), new Set(resources.map(r => r.filePath)), 5, workspaceDir);
    for (const item of missing) {
      const summary = referenceSummary[item.key];
      if (summary) item.references = relativizeReferences(summary.references, workspaceDir);
    }
  } else {
    for (const item of missing) delete item.references;
  }
  const limited = limitItems(missing, limit);
  return { totalMissing: missing.length, limit: limited.limit, truncated: limited.truncated, missing: limited.items };
}

export async function toolRenameKey(args: { from: string; to: string; locales?: string[]; dryRun?: boolean; workspaceDir?: string }): Promise<RenameSummary> {
  const fromKey = typeof args.from === 'string' ? args.from.trim() : '';
  const toKey = typeof args.to === 'string' ? args.to.trim() : '';
  if (!fromKey || !toKey) throw new Error('from and to keys are required');
  if (fromKey === toKey) throw new Error('from and to keys must differ');
  const workspaceDir = resolveWorkspaceDir(args.workspaceDir);
  const resources = await ensureResources(workspaceDir);
  const { structurePreference, insertOrderStrategy } = getEffectiveConfigFromEnv(process.env);
  const manager = createResourceManager(resources, structurePreference, insertOrderStrategy, workspaceDir);
  const dryRun = shouldDryRun(args.dryRun);
  const filter = new Set((args.locales || []).map(normalizeLocaleTag).filter(Boolean));
  const results: RenameSummary['results'] = [];
  const summary: RenameSummary['summary'] = { renamed: 0, skipped: 0, errors: 0 };

  for (const locale of manager.localeMap.keys()) {
    if (filter.size && !filter.has(locale)) continue;
    const state = manager.getState(locale);
    if (!state) continue;
    const current = getValueFromState(state, fromKey);
    if (typeof current === 'undefined') {
      summary.skipped += 1;
      results.push({ localeFile: state.localeFile, locale: state.locale, from: fromKey, to: toKey, result: 'skipped' });
      continue;
    }
    if (typeof getValueFromState(state, toKey) !== 'undefined') {
      summary.errors += 1;
      results.push({ localeFile: state.localeFile, locale: state.locale, from: fromKey, to: toKey, result: 'error', error: `Target key '${toKey}' already exists in ${state.localeFile}` });
      continue;
    }
    deleteKeyFromState(state, fromKey);
    applyValueToState(state, toKey, current);
    summary.renamed += 1;
    results.push({ localeFile: state.localeFile, locale: state.locale, from: fromKey, to: toKey, result: 'renamed', before: current, after: current });
  }
  const changedFiles = manager.commit(dryRun);
  return { dryRun, changedFiles, summary, results };
}

export async function toolMoveNamespace(args: { from: string; to: string; locales?: string[]; dryRun?: boolean; workspaceDir?: string }): Promise<NamespaceMoveSummary> {
  const fromPrefixRaw = typeof args.from === 'string' ? args.from.trim() : '';
  const toPrefixRaw = typeof args.to === 'string' ? args.to.trim() : '';
  if (!fromPrefixRaw || !toPrefixRaw) throw new Error('from and to prefixes are required');
  const fromPrefix = fromPrefixRaw.endsWith('.') ? fromPrefixRaw : `${fromPrefixRaw}.`;
  const toPrefix = toPrefixRaw.endsWith('.') ? toPrefixRaw : `${toPrefixRaw}.`;
  const workspaceDir = resolveWorkspaceDir(args.workspaceDir);
  const resources = await ensureResources(workspaceDir);
  const { structurePreference, insertOrderStrategy } = getEffectiveConfigFromEnv(process.env);
  const manager = createResourceManager(resources, structurePreference, insertOrderStrategy, workspaceDir);
  const dryRun = shouldDryRun(args.dryRun);
  const filter = new Set((args.locales || []).map(normalizeLocaleTag).filter(Boolean));
  const results: NamespaceMoveSummary['results'] = [];
  const summary: NamespaceMoveSummary['summary'] = { moved: 0, skipped: 0, errors: 0 };

  for (const locale of manager.localeMap.keys()) {
    if (filter.size && !filter.has(locale)) continue;
    const state = manager.getState(locale);
    if (!state) continue;
    const currentKeys = listKeysFromState(state).filter(k => k.startsWith(fromPrefix));
    if (!currentKeys.length) {
      summary.skipped += 1;
      results.push({ localeFile: state.localeFile, locale: state.locale, from: fromPrefix, to: toPrefix, movedKeys: [], result: 'skipped' });
      continue;
    }
    const destinationKeys = currentKeys.map(k => `${toPrefix}${k.slice(fromPrefix.length)}`);
    const collision = destinationKeys.find(destKey => typeof getValueFromState(state, destKey) !== 'undefined');
    if (collision) {
      summary.errors += 1;
      results.push({ localeFile: state.localeFile, locale: state.locale, from: fromPrefix, to: toPrefix, movedKeys: [], result: 'error', error: `Key '${collision}' already exists in ${state.localeFile}` });
      continue;
    }
    const movedKeys: string[] = [];
    currentKeys.forEach((sourceKey, index) => {
      const value = getValueFromState(state, sourceKey);
      if (typeof value === 'undefined') return;
      deleteKeyFromState(state, sourceKey);
      applyValueToState(state, destinationKeys[index], value);
      movedKeys.push(destinationKeys[index]);
    });
    summary.moved += movedKeys.length;
    results.push({ localeFile: state.localeFile, locale: state.locale, from: fromPrefix, to: toPrefix, movedKeys, result: 'moved' });
  }
  const changedFiles = manager.commit(dryRun);
  return { dryRun, changedFiles, summary, results };
}

export async function toolValidatePlaceholders(args: { keys?: string[]; locales?: string[]; baseLocale?: string; limit?: number; workspaceDir?: string }) {
  const workspaceDir = resolveWorkspaceDir(args.workspaceDir);
  const limit = normalizeLimit(args.limit);
  const resources = await ensureResources(workspaceDir);
  const localeMap = new Map(resources.map(res => [normalizeLocaleTag(res.fileName), res] as const));
  const selectedLocales = (args.locales ? args.locales.map(normalizeLocaleTag) : Array.from(localeMap.keys())).filter(Boolean);
  if (!selectedLocales.length) throw new Error('No locales available to validate');
  const baseLocale = normalizeLocaleTag(args.baseLocale || selectedLocales[0]);
  if (!baseLocale || !localeMap.has(baseLocale)) throw new Error('Base locale not found in resources');
  const keys = args.keys && args.keys.length
    ? args.keys.map(k => k.trim()).filter(Boolean)
    : Array.from(new Set(Array.from(localeMap.values()).flatMap(res => Object.keys(res.keyValuePairs))));
  const mismatches: PlaceholderMismatch[] = [];
  const missingTranslations: Array<{ key: string; locale: string }> = [];
  const baseResource = localeMap.get(baseLocale)!;
  for (const key of keys) {
    const baseValue = baseResource.keyValuePairs[key];
    if (typeof baseValue === 'undefined') continue;
    const basePlaceholders = extractPlaceholders(baseValue);
    for (const locale of selectedLocales) {
      if (locale === baseLocale) continue;
      const compareValue = localeMap.get(locale)?.keyValuePairs[key];
      if (typeof compareValue === 'undefined') {
        missingTranslations.push({ key, locale });
        continue;
      }
      const comparePlaceholders = extractPlaceholders(compareValue);
      const missing = Array.from(basePlaceholders).filter(ph => !comparePlaceholders.has(ph));
      const extra = Array.from(comparePlaceholders).filter(ph => !basePlaceholders.has(ph));
      if (missing.length || extra.length) mismatches.push({ key, locale, missing, extra });
    }
  }
  const limitedMismatches = limitItems(mismatches, limit);
  const limitedMissing = limitItems(missingTranslations, limit);
  return {
    baseLocale,
    locales: selectedLocales,
    keysChecked: keys.length,
    limit,
    totalMismatches: mismatches.length,
    totalMissingTranslations: missingTranslations.length,
    truncated: limitedMismatches.truncated || limitedMissing.truncated,
    mismatches: limitedMismatches.items,
    missingTranslations: limitedMissing.items,
  };
}

export async function toolKeyReferences(args: { keys?: string[]; limit?: number; workspaceDir?: string }) {
  const keys = Array.isArray(args.keys) ? args.keys : [];
  const trimmedKeys = Array.from(new Set(keys.map(k => typeof k === 'string' ? k.trim() : '').filter(Boolean)));
  if (!trimmedKeys.length) throw new Error('keys array must contain at least one non-empty string');
  const workspaceDir = resolveWorkspaceDir(args.workspaceDir);
  const resources = await ensureResources(workspaceDir);
  const maxPerKey = Math.min(Math.max(args.limit ?? 25, 1), 25);
  const result = await findKeyReferences(trimmedKeys, new Set(resources.map(r => r.filePath)), maxPerKey, workspaceDir);
  for (const summary of Object.values(result)) {
    summary.references = relativizeReferences(summary.references, workspaceDir);
  }
  return result;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function resolveWorkspaceDir(value?: string): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

// ─── Server entry point ──────────────────────────────────────────────────────

type McpToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function toJsonToolResult(value: unknown): McpToolResult {
  const result: McpToolResult = { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    result.structuredContent = value as Record<string, unknown>;
  }
  return result;
}

async function runRegisteredTool(name: string, started: number, cb: () => Promise<unknown>): Promise<McpToolResult> {
  try {
    mcpLogger(`[i18n-codelens MCP] tool.start name=${name}`);
    const result = await cb();
    mcpLogger(`[i18n-codelens MCP] tool.ok name=${name} (${Date.now() - started}ms)`);
    return toJsonToolResult(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    mcpLogger(`[i18n-codelens MCP] tool.error name=${name} message=${msg}`);
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  }
}

export function createI18nMcpServer(version = '1.0.0'): McpServer {
  const server = new McpServer(
    { name: 'i18n-codelens-mcp', version },
    { capabilities: { tools: { listChanged: false } } }
  );
  const registerTool = server.registerTool.bind(server) as any;
  const objectOutputSchema = z.object({}).passthrough();
  const registerJsonTool = (name: string, config: Record<string, unknown>, cb: unknown) => {
    registerTool(name, { outputSchema: objectOutputSchema, ...config }, cb);
  };

  registerJsonTool(
    'i18n_project_info',
    {
      title: 'Inspect i18n Project',
      description: 'Return resolved workspace/configuration metadata and compact locale counts. Use this before large scans.',
      inputSchema: { workspaceDir: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args: any) => runRegisteredTool('i18n_project_info', Date.now(), () => toolProjectInfo(args))
  );

  registerJsonTool(
    'i18n_list_locales',
    {
      title: 'List i18n Locales',
      description: 'Returns all detected locale resource files with normalized locale tags and human-friendly descriptions.',
      inputSchema: { workspaceDir: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args: any) => runRegisteredTool('i18n_list_locales', Date.now(), () => toolListLocales(args))
  );

  registerJsonTool(
    'i18n_check_keys',
    {
      title: 'Check i18n Keys',
      description: 'Check which locale files contain specified keys. Keys ending with a dot are treated as namespace prefix checks.',
      inputSchema: {
        keys: z.array(z.string()).min(1),
        workspaceDir: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args: any) => runRegisteredTool('i18n_check_keys', Date.now(), () => toolCheckKeys(args))
  );

  registerJsonTool(
    'i18n_get_translations',
    {
      title: 'Get i18n Translations',
      description: 'Fetch existing translations for specific keys and locales.',
      inputSchema: {
        keys: z.array(z.string()).min(1),
        locales: z.array(z.string()).optional(),
        workspaceDir: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args: any) => runRegisteredTool('i18n_get_translations', Date.now(), () => toolGetTranslations(args))
  );

  registerJsonTool(
    'i18n_search_keys',
    {
      title: 'Search i18n Keys',
      description: 'Search by key prefix, key text, or value text with limited preview output for large locale files.',
      inputSchema: {
        query: z.string().optional(),
        keyPrefix: z.string().optional(),
        searchIn: z.enum(['keys', 'values', 'both']).optional(),
        locales: z.array(z.string()).optional(),
        caseSensitive: z.boolean().optional(),
        includeValues: z.boolean().optional(),
        maxValueChars: z.number().min(1).max(1000).optional(),
        limit: z.number().min(1).max(500).optional(),
        workspaceDir: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args: any) => runRegisteredTool('i18n_search_keys', Date.now(), () => toolSearchKeys(args))
  );

  registerJsonTool(
    'i18n_get_namespace',
    {
      title: 'Get i18n Namespace',
      description: 'Return a compact, limited view of all keys under a namespace prefix across selected locales.',
      inputSchema: {
        prefix: z.string(),
        locales: z.array(z.string()).optional(),
        includeValues: z.boolean().optional(),
        maxValueChars: z.number().min(1).max(1000).optional(),
        limit: z.number().min(1).max(500).optional(),
        workspaceDir: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args: any) => runRegisteredTool('i18n_get_namespace', Date.now(), () => toolGetNamespace(args))
  );

  registerJsonTool(
    'i18n_upsert_translations',
    {
      title: 'Upsert i18n Translations',
      description: 'Bulk create or update translations. Defaults to dryRun; pass dryRun:false to write files.',
      inputSchema: {
        entries: z.array(z.object({
          key: z.string(),
          values: z.record(z.string()),
        })).min(1),
        dryRun: z.boolean().optional(),
        workspaceDir: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args: any) => runRegisteredTool('i18n_upsert_translations', Date.now(), () => toolUpsertTranslations(args))
  );

  registerJsonTool(
    'i18n_delete_key',
    {
      title: 'Delete i18n Key',
      description: 'Remove a translation key from all or selected locale files. Defaults to dryRun; pass dryRun:false to write files.',
      inputSchema: {
        key: z.string(),
        locales: z.array(z.string()).optional(),
        dryRun: z.boolean().optional(),
        workspaceDir: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args: any) => runRegisteredTool('i18n_delete_key', Date.now(), () => toolDeleteKey(args))
  );

  registerJsonTool(
    'i18n_diff_locales',
    {
      title: 'Diff i18n Locales',
      description: 'Compare base locale keys against one or more locales, highlighting missing, extra, and placeholder differences.',
      inputSchema: {
        base: z.string(),
        compare: z.array(z.string()).min(1),
        limit: z.number().min(1).max(500).optional(),
        workspaceDir: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args: any) => runRegisteredTool('i18n_diff_locales', Date.now(), () => toolDiffLocales(args))
  );

  registerJsonTool(
    'i18n_scan_workspace_missing',
    {
      title: 'Scan Missing i18n Keys',
      description: 'Scan code files for referenced keys missing from at least one locale resource.',
      inputSchema: {
        limit: z.number().min(1).max(500).optional(),
        includeReferences: z.boolean().optional(),
        workspaceDir: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args: any) => runRegisteredTool('i18n_scan_workspace_missing', Date.now(), () => toolScanWorkspaceMissing(args))
  );

  registerJsonTool(
    'i18n_unused_keys',
    {
      title: 'Find Unused i18n Keys',
      description: 'Find locale keys that are not referenced in source code, returning a limited compact list.',
      inputSchema: {
        locales: z.array(z.string()).optional(),
        limit: z.number().min(1).max(500).optional(),
        workspaceDir: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args: any) => runRegisteredTool('i18n_unused_keys', Date.now(), () => toolUnusedKeys(args))
  );

  registerJsonTool(
    'i18n_audit',
    {
      title: 'Audit i18n Project',
      description: 'Return a compact audit summary for missing translations, placeholder mismatches, code-missing keys, and unused keys.',
      inputSchema: {
        baseLocale: z.string().optional(),
        locales: z.array(z.string()).optional(),
        limit: z.number().min(1).max(500).optional(),
        workspaceDir: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args: any) => runRegisteredTool('i18n_audit', Date.now(), () => toolAudit(args))
  );

  registerJsonTool(
    'i18n_key_references',
    {
      title: 'Find i18n Key References',
      description: 'Surface non-locale code references for given keys with file, line, and column details.',
      inputSchema: {
        keys: z.array(z.string()).min(1),
        limit: z.number().min(1).max(25).optional(),
        workspaceDir: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args: any) => runRegisteredTool('i18n_key_references', Date.now(), () => toolKeyReferences(args))
  );

  registerJsonTool(
    'i18n_rename_key',
    {
      title: 'Rename i18n Key',
      description: 'Rename a translation key across all or selected locales with collision checks. Defaults to dryRun; pass dryRun:false to write files.',
      inputSchema: {
        from: z.string(),
        to: z.string(),
        locales: z.array(z.string()).optional(),
        dryRun: z.boolean().optional(),
        workspaceDir: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args: any) => runRegisteredTool('i18n_rename_key', Date.now(), () => toolRenameKey(args))
  );

  registerJsonTool(
    'i18n_move_namespace',
    {
      title: 'Move i18n Namespace',
      description: 'Move an entire key namespace prefix to a new location. Defaults to dryRun; pass dryRun:false to write files.',
      inputSchema: {
        from: z.string(),
        to: z.string(),
        locales: z.array(z.string()).optional(),
        dryRun: z.boolean().optional(),
        workspaceDir: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args: any) => runRegisteredTool('i18n_move_namespace', Date.now(), () => toolMoveNamespace(args))
  );

  registerJsonTool(
    'i18n_validate_placeholders',
    {
      title: 'Validate i18n Placeholders',
      description: 'Validate placeholder parity across locales.',
      inputSchema: {
        keys: z.array(z.string()).optional(),
        locales: z.array(z.string()).optional(),
        baseLocale: z.string().optional(),
        limit: z.number().min(1).max(500).optional(),
        workspaceDir: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args: any) => runRegisteredTool('i18n_validate_placeholders', Date.now(), () => toolValidatePlaceholders(args))
  );

  registerJsonTool(
    'i18n_format_resources',
    {
      title: 'Format i18n Resources',
      description: 'Preview or apply normalized JSON formatting and optional sorted keys. Defaults to dryRun; pass dryRun:false to write files.',
      inputSchema: {
        locales: z.array(z.string()).optional(),
        sortKeys: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        workspaceDir: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args: any) => runRegisteredTool('i18n_format_resources', Date.now(), () => toolFormatResources(args))
  );

  registerJsonTool(
    'i18n_untranslated_keys_on_page',
    {
      title: 'Find Page Missing i18n Keys',
      description: 'Find translation keys used in a source file that are missing from at least one locale.',
      inputSchema: {
        filePath: z.string(),
        workspaceDir: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args: any) => runRegisteredTool('i18n_untranslated_keys_on_page', Date.now(), async () => ({
      keys: await toolUntranslatedKeysOnPage(args),
    }))
  );

  return server;
}

function setupRemoteLogger(): void {
  // Optional remote logger for VS Code extension output channel
  const portRaw = process.env.I18N_MCP_LOG_PORT;
  const queue: string[] = [];
  let socket: net.Socket | undefined;
  let tries = 0;
  const connect = () => {
    const port = portRaw ? parseInt(portRaw, 10) : NaN;
    if (!portRaw || Number.isNaN(port)) return;
    try {
      const s = net.createConnection({ host: '127.0.0.1', port }, () => {
        socket = s;
        while (queue.length) {
          const line = queue.shift();
          if (typeof line === 'string') try { s.write(line + '\n'); } catch { /* ignore */ }
        }
      });
      s.on('error', () => { socket = undefined; if (tries < 5) { tries++; setTimeout(connect, 300 * tries); } });
      s.on('close', () => { socket = undefined; });
    } catch { if (tries < 5) { tries++; setTimeout(connect, 300 * tries); } }
  };
  connect();
  mcpLogger = (msg: string) => {
    safeStderr(msg);
    if (socket && socket.writable) try { socket.write(msg + '\n'); } catch { /* ignore */ }
    else queue.push(msg);
  };
}

export async function startServer(version = '1.0.0'): Promise<void> {
  setupRemoteLogger();

  try {
    mcpLogger(`[i18n-codelens MCP] node=${process.version} platform=${process.platform} pid=${process.pid}`);
    mcpLogger(`[i18n-codelens MCP] cwd=${process.cwd()}`);
    mcpLogger(`[i18n-codelens MCP] workspace root: ${getWorkspaceRoot()}`);
    const eff = getEffectiveConfigFromEnv(process.env);
    mcpLogger(`[i18n-codelens MCP] config: resourceGlob='${eff.resourceGlob}', codeGlob='${eff.codeGlob}'`);
  } catch { /* ignore */ }

  const server = createI18nMcpServer(version);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  mcpLogger('[i18n-codelens MCP] server connected (stdio)');
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  startServer().catch((err: unknown) => {
    const msg = err instanceof Error ? err.stack || err.message : String(err);
    safeStderr(`[i18n-codelens MCP] fatal: ${msg}`);
    process.exitCode = 1;
  });
}
