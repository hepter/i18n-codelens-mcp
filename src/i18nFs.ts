import fs from 'fs';
import path from 'path';
import fg from 'fast-glob';
import ignore from 'ignore';
import { flattenObject, isObjectNested, setNestedValue, deleteNestedKey, type FlatResourceMap } from './resourceUtils';
import { DEFAULT_RESOURCE_GLOB, DEFAULT_CODE_GLOB, buildCodeRegex, getEffectiveConfigFromEnv } from './config';

export { setNestedValue, deleteNestedKey };
export type { FlatResourceMap };

export type ResourceFile = {
  filePath: string;
  fileName: string;
  isNested: boolean;
  keyValuePairs: FlatResourceMap;
};

export type KeyReference = {
  filePath: string;
  line: number;
  column: number;
};

export type KeyReferenceSummary = {
  total: number;
  references: KeyReference[];
};

// ─── Workspace root resolution ───────────────────────────────────────────────

function readArgValue(names: string[]): string | undefined {
  const argv = Array.isArray(process.argv) ? process.argv : [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] || '';
    for (const name of names) {
      if (arg === name && argv[i + 1]) return argv[i + 1];
      const prefix = `${name}=`;
      if (arg.startsWith(prefix)) return arg.slice(prefix.length);
    }
  }
  return undefined;
}

function isUsableDir(p?: string): boolean {
  if (!p) return false;
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Resolve the workspace root with this precedence:
 * 0) workspaceRootOverride (per-call)
 * 1) CLI arg: --workspaceRoot / --workspace-root (supports =value)
 * 2) Env: WORKSPACE_ROOT
 * 3) process.cwd()
 * 4) __dirname-based server location fallback
 */
export function getWorkspaceRoot(workspaceRootOverride?: string): string {
  const overrideRoot = workspaceRootOverride ? path.resolve(workspaceRootOverride) : undefined;
  const argRootRaw = readArgValue(['--workspaceRoot', '--workspace-root']);
  const argRoot = argRootRaw ? path.resolve(argRootRaw) : undefined;
  const envRoot = process.env.WORKSPACE_ROOT ? path.resolve(process.env.WORKSPACE_ROOT) : undefined;
  const cwdRoot = path.resolve(process.cwd());
  const serverRoot = path.resolve(__dirname, '..'); // dist root (from out/)

  const candidates = [overrideRoot, argRoot, envRoot, cwdRoot, serverRoot];
  let chosen = cwdRoot;
  for (const candidate of candidates) {
    if (isUsableDir(candidate)) {
      chosen = candidate!;
      break;
    }
  }
  try { process.stderr.write(`[i18n-codelens MCP] workspace root: ${chosen}\n`); } catch { /* ignore */ }
  return chosen;
}

// ─── Path safety ─────────────────────────────────────────────────────────────

function normalizePathCasing(target: string): string {
  return process.platform === 'win32' ? target.toLowerCase() : target;
}

export function ensureSafeWorkspacePath(absPath: string, workspaceRootOverride?: string): string {
  const root = path.resolve(getWorkspaceRoot(workspaceRootOverride));
  const normalizedRoot = normalizePathCasing(root);
  const resolved = path.resolve(absPath);
  const normalizedResolved = normalizePathCasing(resolved);

  if (normalizedResolved !== normalizedRoot && !normalizedResolved.startsWith(normalizedRoot + path.sep)) {
    throw new Error(`Refusing to access path outside workspace root: ${absPath}`);
  }

  let current = resolved;
  while (normalizePathCasing(current) !== normalizedRoot) {
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing to follow symbolic link while accessing ${absPath}`);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return resolved;
}

// ─── File I/O ────────────────────────────────────────────────────────────────

export function loadJson(absPath: string, workspaceRootOverride?: string): unknown {
  const target = ensureSafeWorkspacePath(absPath, workspaceRootOverride);
  const raw = fs.readFileSync(target, 'utf8');
  return JSON.parse(raw);
}

export function writeFilePretty(absPath: string, json: unknown, workspaceRootOverride?: string): void {
  const target = ensureSafeWorkspacePath(absPath, workspaceRootOverride);
  const content = JSON.stringify(json, null, 2) + '\n';
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });

  const tempFile = path.join(dir, `${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tempFile, content, 'utf8');
    fs.renameSync(tempFile, target);
  } catch (error) {
    if (fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch { /* best-effort cleanup */ }
    }
    throw error;
  }
}

// ─── Resource scanning ───────────────────────────────────────────────────────

const FG_SAFE_OPTIONS = {
  onlyFiles: true,
  dot: false,
  followSymbolicLinks: false,
  suppressErrors: true,
  throwErrorOnBrokenSymbolicLink: false,
} as const;

export async function readResourceFiles(globPattern?: string, workspaceRootOverride?: string): Promise<ResourceFile[]> {
  const root = getWorkspaceRoot(workspaceRootOverride);
  const envCfg = getEffectiveConfigFromEnv(process.env);
  const pattern = globPattern || envCfg.resourceGlob || DEFAULT_RESOURCE_GLOB;

  const entries = await fg(pattern, {
    cwd: root,
    absolute: true,
    ignore: envCfg.ignoreGlobs,
    ...FG_SAFE_OPTIONS,
  });

  entries.sort((a, b) => path.parse(a).name.localeCompare(path.parse(b).name));

  const result: ResourceFile[] = [];
  for (const absPath of entries) {
    try {
      const raw = fs.readFileSync(absPath, 'utf8');
      const json = JSON.parse(raw);
      result.push({
        filePath: absPath,
        fileName: path.parse(absPath).name,
        isNested: isObjectNested(json),
        keyValuePairs: flattenObject(json),
      });
    } catch { /* skip invalid JSON */ }
  }
  return result;
}

// ─── Key extraction ──────────────────────────────────────────────────────────

export function findUntranslatedKeysInFile(codeFilePath: string, keys: string[]): string[] {
  const raw = fs.readFileSync(codeFilePath, 'utf8');
  const rx = buildCodeRegex(process.env.I18N_CODE_REGEX);
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = rx.exec(raw)) !== null) {
    const k = (m.groups && (m.groups as Record<string, string>).key) || m[0];
    if (k) found.add(k);
  }
  const arr = Array.from(found);
  return keys && keys.length ? arr.filter(k => keys.includes(k)) : arr;
}

// ─── Key references ──────────────────────────────────────────────────────────

function computeLineStarts(text: string): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function indexToPosition(lineStarts: number[], index: number): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const start = lineStarts[mid];
    const nextStart = mid + 1 < lineStarts.length ? lineStarts[mid + 1] : Number.MAX_SAFE_INTEGER;
    if (index < start) {
      high = mid - 1;
    } else if (index >= nextStart) {
      low = mid + 1;
    } else {
      return { line: mid + 1, column: index - start + 1 };
    }
  }
  return { line: 1, column: index + 1 };
}

export async function findKeyReferences(
  keys: string[],
  resourceFilePaths: Set<string>,
  limitPerKey = 25,
  workspaceRootOverride?: string
): Promise<Record<string, KeyReferenceSummary>> {
  const summaries: Record<string, KeyReferenceSummary> = {};
  if (!keys.length) return summaries;

  const workspaceRoot = getWorkspaceRoot(workspaceRootOverride);
  const envCfg = getEffectiveConfigFromEnv(process.env);
  const codeFiles = await fg(envCfg.codeGlob || DEFAULT_CODE_GLOB, {
    cwd: workspaceRoot,
    absolute: true,
    ignore: envCfg.ignoreGlobs,
    ...FG_SAFE_OPTIONS,
  });

  let ig = ignore();
  try {
    const content = fs.readFileSync(path.join(workspaceRoot, '.gitignore'), 'utf8');
    ig = ignore().add(content);
  } catch { /* no .gitignore */ }

  const normalizedResourcePaths = new Set(Array.from(resourceFilePaths).map(p => path.normalize(p)));
  const keysSet = new Set(keys);
  for (const key of keys) summaries[key] = { total: 0, references: [] };

  const regexPattern = buildCodeRegex(process.env.I18N_CODE_REGEX);

  for (const filePath of codeFiles) {
    if (normalizedResourcePaths.has(path.normalize(filePath))) continue;
    const rel = path.relative(workspaceRoot, filePath);
    if (rel && ig.ignores(rel)) continue;

    let content: string;
    try { content = fs.readFileSync(filePath, 'utf8'); } catch { continue; }

    const lineStarts = computeLineStarts(content);
    const rx = new RegExp(regexPattern.source, regexPattern.flags);
    let match: RegExpExecArray | null;
    while ((match = rx.exec(content)) !== null) {
      const matchedKey = (match.groups && (match.groups as Record<string, string>).key) || match[0];
      if (!keysSet.has(matchedKey)) continue;
      const summary = summaries[matchedKey];
      summary.total += 1;
      if (summary.references.length < limitPerKey) {
        const position = indexToPosition(lineStarts, match.index ?? 0);
        summary.references.push({ filePath, line: position.line, column: position.column });
      }
    }
  }

  return summaries;
}
