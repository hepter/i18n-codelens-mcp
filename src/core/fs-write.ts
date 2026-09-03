import fs from 'fs';
import path from 'path';
import { flattenObject } from '../resource-utils';
import { ensureSafeWorkspacePath, toPosixPath } from './workspace';

export function loadJson(absPath: string, root: string): unknown {
  const target = ensureSafeWorkspacePath(absPath, root);
  const raw = fs.readFileSync(target, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${toPosixPath(target)}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export type WriteGuardOptions = {
  /** Keys the caller means to remove, for example a delete or a rename. */
  allowRemovedKeys?: string[];
  /** Skip the guard entirely. Only for files that are not locale resources. */
  allowKeyLoss?: boolean;
};

/**
 * Refuse a write that would drop keys the file already has. This is the last
 * line of defence: whatever the caller believes it is doing, a translation
 * file may only lose a key that was named as an intended removal.
 */
function assertNoKeyLoss(target: string, json: unknown, options?: WriteGuardOptions): void {
  if (options?.allowKeyLoss) return;
  let existing: unknown;
  try {
    existing = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return; // no readable prior document, nothing can be lost
  }
  if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) return;

  const allowed = new Set(options?.allowRemovedKeys ?? []);
  const nextKeys = new Set(Object.keys(flattenObject(json)));
  const lost = Object.keys(flattenObject(existing)).filter(key => !nextKeys.has(key) && !allowed.has(key));
  if (!lost.length) return;

  const shown = lost.slice(0, 5).join(', ');
  const rest = lost.length > 5 ? `, and ${lost.length - 5} more` : '';
  throw new Error(
    `Refusing to write ${path.basename(target)}: the new content is missing ${lost.length} existing key(s) (${shown}${rest}). ` +
    'Nothing was written. Declare intended removals with allowRemovedKeys.'
  );
}

/** Atomic pretty write (2 spaces, trailing newline) guarded against key loss. */
export function writeFilePretty(absPath: string, json: unknown, root: string, options?: WriteGuardOptions): void {
  const target = ensureSafeWorkspacePath(absPath, root);
  assertNoKeyLoss(target, json, options);
  const content = JSON.stringify(json, null, 2) + '\n';
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tempFile = path.join(dir, `${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tempFile, content, 'utf8');
    fs.renameSync(tempFile, target);
  } catch (error) {
    try { fs.unlinkSync(tempFile); } catch { /* best effort */ }
    throw error;
  }
}
