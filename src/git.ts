import * as fs from 'fs';
import * as path from 'path';

/**
 * Returns true if projectRoot (or any ancestor) contains a .git directory.
 * Walks up the directory tree to handle nested projects.
 */
export function isGitRepo(projectRoot: string): boolean {
  let dir = path.resolve(projectRoot);
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, '.git'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

/**
 * Read the current git branch from .git/HEAD (no subprocess — pure file read).
 * Returns null if the directory is not a git repo.
 * Returns the first 8 chars of the commit hash when in detached HEAD state.
 */
export function getCurrentBranch(projectRoot: string): string | null {
  if (!isGitRepo(projectRoot)) return null;
  try {
    const headFile = path.join(projectRoot, '.git', 'HEAD');
    const head = fs.readFileSync(headFile, 'utf-8').trim();
    if (head.startsWith('ref: refs/heads/')) {
      return head.slice('ref: refs/heads/'.length);
    }
    // Detached HEAD — use short commit hash so the data dir is still stable
    return `detached-${head.slice(0, 8)}`;
  } catch {
    return null;
  }
}

/**
 * Sanitise a branch name so it can be used as a directory name.
 * e.g. "feature/auth-service" → "feature-auth-service"
 */
export function branchSlug(branch: string): string {
  return (
    branch
      .replace(/[/\\:*?"<>|]/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '') || 'default'
  );
}

/**
 * Returns the data directory for index files:
 *   git project  → <projectRoot>/.code-intelligence/<branch-slug>/
 *   non-git      → <projectRoot>/.code-intelligence/
 *
 * Non-git projects use a flat layout since there are no branches to isolate.
 */
export function getDataDir(projectRoot: string): string {
  const branch = getCurrentBranch(projectRoot);
  if (branch === null) {
    // Not a git repo — use flat layout, no branch subdirectory
    return path.join(projectRoot, '.code-intelligence');
  }
  return path.join(projectRoot, '.code-intelligence', branchSlug(branch));
}
