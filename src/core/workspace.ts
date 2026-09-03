import fs from 'fs';
import path from 'path';

function readArgValue(argv: string[], names: string[]): string | undefined {
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

export function isDirectory(p?: string): boolean {
  if (!p) return false;
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Resolve the workspace root. Precedence:
 * 1. per-call override
 * 2. CLI `--workspaceRoot` / `--workspace-root` (also `=value`)
 * 3. `WORKSPACE_ROOT`
 * 4. `CLAUDE_PROJECT_DIR` (set by Claude Code for stdio servers)
 * 5. process.cwd()
 * 6. the directory that contains this package
 */
export function getWorkspaceRoot(override?: string, env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): string {
  const argRoot = readArgValue(argv, ['--workspaceRoot', '--workspace-root']);
  const candidates = [
    override,
    argRoot,
    env.WORKSPACE_ROOT,
    env.CLAUDE_PROJECT_DIR,
    process.cwd(),
    path.resolve(__dirname, '..', '..'),
  ];
  for (const candidate of candidates) {
    if (!candidate || !candidate.trim()) continue;
    const resolved = path.resolve(candidate);
    if (isDirectory(resolved)) return resolved;
  }
  return path.resolve(process.cwd());
}

function normalizeCasing(target: string): string {
  return process.platform === 'win32' ? target.toLowerCase() : target;
}

/** True when `target` is `root` itself or lives underneath it. */
export function isInsideRoot(root: string, target: string): boolean {
  const normalizedRoot = normalizeCasing(path.resolve(root));
  const normalizedTarget = normalizeCasing(path.resolve(target));
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + path.sep);
}

export type ResolveWorkspaceOptions = {
  configuredRoot: string;
  allowAnyWorkspace: boolean;
};

/**
 * Resolve the optional per-call `workspaceDir` argument. The result must be an
 * existing directory and, unless I18N_ALLOW_ANY_WORKSPACE is set, must lie
 * inside the configured root: a tool argument must not be able to point the
 * server at an arbitrary directory on disk.
 */
export function resolveWorkspaceDir(requested: string | undefined, options: ResolveWorkspaceOptions): string {
  const configuredRoot = path.resolve(options.configuredRoot);
  const trimmed = typeof requested === 'string' ? requested.trim() : '';
  if (!trimmed) return configuredRoot;
  const resolved = path.resolve(configuredRoot, trimmed);
  if (!isDirectory(resolved)) {
    throw new Error(`workspaceDir '${requested}' is not a directory (resolved to ${toPosixPath(resolved)}).`);
  }
  if (!options.allowAnyWorkspace && !isInsideRoot(configuredRoot, resolved)) {
    throw new Error(
      `workspaceDir '${requested}' is outside the configured workspace root ${toPosixPath(configuredRoot)}. ` +
      'Omit it, pass a sub-directory, or start the server with I18N_ALLOW_ANY_WORKSPACE=1.'
    );
  }
  return resolved;
}

/** Resolve `absPath`, refusing anything outside `root` or reached through a symlink. */
export function ensureSafeWorkspacePath(absPath: string, root: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(absPath);
  if (!isInsideRoot(resolvedRoot, resolved)) {
    throw new Error(`Refusing to access path outside workspace root: ${toPosixPath(absPath)}`);
  }
  let current = resolved;
  while (normalizeCasing(current) !== normalizeCasing(resolvedRoot)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(`Refusing to follow symbolic link while accessing ${toPosixPath(absPath)}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolved;
}

export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Workspace-relative posix path, or an absolute posix path when outside the root. */
export function relativeToWorkspace(filePath: string, root: string): string {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return toPosixPath(path.resolve(filePath));
  return toPosixPath(relative);
}
