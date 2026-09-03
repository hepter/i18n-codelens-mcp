import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getWorkspaceRoot,
  resolveWorkspaceDir,
  ensureSafeWorkspacePath,
  relativeToWorkspace,
  toPosixPath,
  isInsideRoot,
} from '../core/workspace';

let tmp: string;
let projectA: string;
let projectB: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-ws-'));
  projectA = path.join(tmp, 'project-a');
  projectB = path.join(tmp, 'project-b');
  fs.mkdirSync(path.join(projectA, 'src', 'locales'), { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('getWorkspaceRoot', () => {
  it('per-call override wins over everything', () => {
    expect(getWorkspaceRoot(projectA, { WORKSPACE_ROOT: projectB, CLAUDE_PROJECT_DIR: projectB }, [])).toBe(path.resolve(projectA));
  });

  it('resolves a relative override against cwd', () => {
    expect(getWorkspaceRoot('.', {}, [])).toBe(path.resolve('.'));
  });

  it('CLI --workspaceRoot beats WORKSPACE_ROOT', () => {
    expect(getWorkspaceRoot(undefined, { WORKSPACE_ROOT: projectB }, ['node', 'x', '--workspaceRoot', projectA])).toBe(path.resolve(projectA));
    expect(getWorkspaceRoot(undefined, { WORKSPACE_ROOT: projectB }, ['node', 'x', `--workspace-root=${projectA}`])).toBe(path.resolve(projectA));
  });

  it('WORKSPACE_ROOT beats CLAUDE_PROJECT_DIR', () => {
    expect(getWorkspaceRoot(undefined, { WORKSPACE_ROOT: projectA, CLAUDE_PROJECT_DIR: projectB }, [])).toBe(path.resolve(projectA));
  });

  it('CLAUDE_PROJECT_DIR set by Claude Code beats the current working directory', () => {
    expect(getWorkspaceRoot(undefined, { CLAUDE_PROJECT_DIR: projectB }, [])).toBe(path.resolve(projectB));
  });

  it('skips candidates that are not directories', () => {
    expect(getWorkspaceRoot(undefined, { WORKSPACE_ROOT: path.join(tmp, 'missing'), CLAUDE_PROJECT_DIR: projectB }, [])).toBe(path.resolve(projectB));
  });

  it('falls back to cwd when nothing is configured', () => {
    expect(getWorkspaceRoot(undefined, {}, [])).toBe(path.resolve(process.cwd()));
  });
});

describe('resolveWorkspaceDir', () => {
  it('returns the configured root when nothing is requested', () => {
    expect(resolveWorkspaceDir(undefined, { configuredRoot: projectA, allowAnyWorkspace: false })).toBe(path.resolve(projectA));
    expect(resolveWorkspaceDir('   ', { configuredRoot: projectA, allowAnyWorkspace: false })).toBe(path.resolve(projectA));
  });

  it('accepts a sub-directory of the configured root, relative or absolute', () => {
    const expected = path.resolve(projectA, 'src');
    expect(resolveWorkspaceDir('src', { configuredRoot: projectA, allowAnyWorkspace: false })).toBe(expected);
    expect(resolveWorkspaceDir(expected, { configuredRoot: projectA, allowAnyWorkspace: false })).toBe(expected);
  });

  it('refuses a directory outside the configured root and names the escape hatch', () => {
    expect(() => resolveWorkspaceDir(projectB, { configuredRoot: projectA, allowAnyWorkspace: false })).toThrow(/I18N_ALLOW_ANY_WORKSPACE/);
    expect(() => resolveWorkspaceDir('..', { configuredRoot: projectA, allowAnyWorkspace: false })).toThrow(/outside/);
  });

  it('allows any existing directory when the escape hatch is on', () => {
    expect(resolveWorkspaceDir(projectB, { configuredRoot: projectA, allowAnyWorkspace: true })).toBe(path.resolve(projectB));
  });

  it('refuses a path that is not a directory', () => {
    expect(() => resolveWorkspaceDir('does-not-exist', { configuredRoot: projectA, allowAnyWorkspace: false })).toThrow(/not a directory/);
  });
});

describe('isInsideRoot / ensureSafeWorkspacePath', () => {
  it('treats the root itself and its children as inside', () => {
    expect(isInsideRoot(projectA, projectA)).toBe(true);
    expect(isInsideRoot(projectA, path.join(projectA, 'src', 'x.json'))).toBe(true);
    expect(isInsideRoot(projectA, projectB)).toBe(false);
    expect(isInsideRoot(projectA, projectA + '-b')).toBe(false);
  });

  it('returns the resolved path for a file inside the root', () => {
    const target = path.join(projectA, 'src', 'locales', 'en.json');
    expect(ensureSafeWorkspacePath(target, projectA)).toBe(path.resolve(target));
  });

  it('throws for a path outside the root', () => {
    expect(() => ensureSafeWorkspacePath(path.join(projectB, 'en.json'), projectA)).toThrow(/outside workspace root/);
  });
});

describe('path helpers', () => {
  it('toPosixPath converts backslashes', () => {
    expect(toPosixPath('src\\locales\\en.json')).toBe('src/locales/en.json');
  });

  it('relativeToWorkspace returns a posix relative path inside the root', () => {
    expect(relativeToWorkspace(path.join(projectA, 'src', 'locales', 'en.json'), projectA)).toBe('src/locales/en.json');
  });

  it('relativeToWorkspace returns an absolute posix path outside the root', () => {
    const outside = path.join(projectB, 'en.json');
    const result = relativeToWorkspace(outside, projectA);
    expect(result).not.toContain('\\');
    expect(result.endsWith('project-b/en.json')).toBe(true);
    expect(result.startsWith('..')).toBe(false);
  });
});
