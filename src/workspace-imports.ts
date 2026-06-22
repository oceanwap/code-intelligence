import * as path from 'path';
import { stripJsonComments } from './indexer.js';

const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];
const INDEX_FILES = RESOLVE_EXTS.map(ext => `index${ext}`);

export interface WorkspacePackage {
  /** Package name as declared in its package.json */
  name: string;
  /** Directory containing the package, relative to projectRoot (forward-slash) */
  root: string;
  /** Primary entry point, relative to projectRoot (forward-slash), or null */
  entry: string | null;
}

export interface TsConfigPaths {
  /** Base directory for path mappings, relative to projectRoot (forward-slash) */
  baseUrl?: string;
  /** Raw paths mapping from tsconfig */
  paths: Record<string, string[]>;
}

export interface WorkspaceResolver {
  projectRoot: string;
  packages: WorkspacePackage[];
  tsConfig: TsConfigPaths;
}

function toForwardSlash(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function relativeToProject(projectRoot: string, absPath: string): string {
  return toForwardSlash(path.relative(projectRoot, absPath));
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    return await Bun.file(absPath).exists();
  } catch {
    return false;
  }
}

async function readJsonFileAsync(absPath: string): Promise<Record<string, unknown> | null> {
  try {
    const file = Bun.file(absPath);
    if (!(await file.exists())) return null;
    const text = await file.text();
    return JSON.parse(stripJsonComments(text)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function resolvePackageEntryAsync(projectRoot: string, packageRoot: string): Promise<string | null> {
  const packageJsonPath = path.join(projectRoot, packageRoot, 'package.json');
  const parsed = await readJsonFileAsync(packageJsonPath);
  if (!parsed) return null;

  const entryCandidates: string[] = [];

  const exportsField = parsed.exports;
  if (typeof exportsField === 'string') {
    entryCandidates.push(exportsField);
  } else if (typeof exportsField === 'object' && exportsField !== null && !Array.isArray(exportsField)) {
    const exportMap = exportsField as Record<string, unknown>;
    const rootExport = exportMap['.'];
    if (typeof rootExport === 'string') {
      entryCandidates.push(rootExport);
    } else if (typeof rootExport === 'object' && rootExport !== null) {
      const conditional = rootExport as Record<string, unknown>;
      for (const key of ['import', 'require', 'default', 'types', 'node']) {
        const value = conditional[key];
        if (typeof value === 'string') {
          entryCandidates.push(value);
          break;
        }
      }
    }
    // Fallback: first string value anywhere in the exports object
    for (const value of Object.values(exportMap)) {
      if (typeof value === 'string') {
        entryCandidates.push(value);
        break;
      }
    }
  }

  for (const key of ['module', 'main', 'types', 'typings']) {
    const value = parsed[key];
    if (typeof value === 'string') entryCandidates.push(value);
  }

  for (const candidate of entryCandidates) {
    const resolved = path.normalize(path.join(projectRoot, packageRoot, candidate));
    if (await fileExists(resolved)) {
      return relativeToProject(projectRoot, resolved);
    }
    // Try adding an extension
    for (const ext of RESOLVE_EXTS) {
      const withExt = resolved + ext;
      if (await fileExists(withExt)) return relativeToProject(projectRoot, withExt);
    }
  }

  // Fallback: look for an index file at the package root
  for (const indexFile of INDEX_FILES) {
    const candidate = path.join(projectRoot, packageRoot, indexFile);
    if (await fileExists(candidate)) return relativeToProject(projectRoot, candidate);
  }

  return null;
}

function parseWorkspaceGlobs(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const globs: string[] = [];
  let insidePackages = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (insidePackages) {
      if (/^[a-zA-Z]/.test(line) && !line.startsWith('-')) {
        insidePackages = false;
        continue;
      }
      const match = /^-\s*['"]?(.+?)['"]?\s*$/.exec(line);
      if (match) globs.push(match[1]);
    } else if (line.startsWith('packages:')) {
      insidePackages = true;
    }
  }
  return globs;
}

async function collectPackageRootsFromGlobs(projectRoot: string, globs: string[]): Promise<string[]> {
  const roots: string[] = [];
  for (const glob of globs) {
    const normalized = toForwardSlash(glob);
    if (normalized.endsWith('/*')) {
      const base = normalized.slice(0, -2);
      const baseAbs = path.join(projectRoot, base);
      try {
        for await (const entry of await import('node:fs/promises').then(m => m.opendir(baseAbs))) {
          if (entry.isDirectory()) {
            const packageJson = path.join(baseAbs, entry.name, 'package.json');
            if (await fileExists(packageJson)) {
              roots.push(toForwardSlash(path.join(base, entry.name)));
            }
          }
        }
      } catch {
        // ignore missing base dir
      }
    } else if (normalized.includes('**')) {
      const base = normalized.replace(/\/\*\*.*$/, '') || '.';
      const pattern = normalized.replace(/^.*?\*\*\//, '').replace(/^.*?\*\*/, '**/package.json');
      const fullPattern = base === '.' ? pattern : `${base}/${pattern}`;
      const glob = new Bun.Glob(fullPattern);
      for (const rel of glob.scanSync({ cwd: projectRoot, onlyFiles: true })) {
        roots.push(toForwardSlash(path.dirname(rel)));
      }
    } else if (normalized.endsWith('/package.json')) {
      const base = normalized.slice(0, -'/package.json'.length);
      if (await fileExists(path.join(projectRoot, base, 'package.json'))) {
        roots.push(base);
      }
    } else {
      // Treat as a literal package directory
      if (await fileExists(path.join(projectRoot, normalized, 'package.json'))) {
        roots.push(normalized);
      }
    }
  }
  return [...new Set(roots)];
}

async function loadWorkspaceGlobsAsync(projectRoot: string): Promise<string[]> {
  const globs: string[] = [];

  // pnpm-workspace.yaml
  const pnpmWorkspace = path.join(projectRoot, 'pnpm-workspace.yaml');
  try {
    const file = Bun.file(pnpmWorkspace);
    if (await file.exists()) {
      globs.push(...parseWorkspaceGlobs(await file.text()));
    }
  } catch {
    // ignore
  }

  // package.json workspaces (npm/yarn)
  const rootPackageJson = await readJsonFileAsync(path.join(projectRoot, 'package.json'));
  const workspacesField = rootPackageJson?.workspaces;
  if (Array.isArray(workspacesField)) {
    for (const item of workspacesField) {
      if (typeof item === 'string') globs.push(item);
    }
  } else if (typeof workspacesField === 'object' && workspacesField !== null) {
    const packages = (workspacesField as Record<string, unknown>).packages;
    if (Array.isArray(packages)) {
      for (const item of packages) {
        if (typeof item === 'string') globs.push(item);
      }
    }
  }

  // lerna.json
  const lernaJson = await readJsonFileAsync(path.join(projectRoot, 'lerna.json'));
  if (Array.isArray(lernaJson?.packages)) {
    for (const item of lernaJson.packages as unknown[]) {
      if (typeof item === 'string') globs.push(item);
    }
  }

  // rush.json
  const rushJson = await readJsonFileAsync(path.join(projectRoot, 'rush.json'));
  const projects = rushJson?.projects;
  if (Array.isArray(projects)) {
    for (const project of projects) {
      if (typeof project === 'object' && project !== null) {
        const folder = (project as Record<string, unknown>).projectFolder;
        if (typeof folder === 'string') globs.push(folder);
      }
    }
  }

  return [...new Set(globs)];
}

export async function loadWorkspacePackagesAsync(projectRoot: string): Promise<WorkspacePackage[]> {
  const resolvedRoot = path.resolve(projectRoot);
  const globs = await loadWorkspaceGlobsAsync(resolvedRoot);
  const roots = await collectPackageRootsFromGlobs(resolvedRoot, globs);

  // Also include the root package itself so self-references resolve
  if (await fileExists(path.join(resolvedRoot, 'package.json'))) {
    roots.push('.');
  }

  const packages: WorkspacePackage[] = [];
  for (const root of [...new Set(roots)]) {
    const packageJson = await readJsonFileAsync(path.join(resolvedRoot, root, 'package.json'));
    const name = typeof packageJson?.name === 'string' ? packageJson.name : null;
    if (!name) continue;
    const entry = root === '.' ? null : await resolvePackageEntryAsync(resolvedRoot, root);
    packages.push({ name, root: root === '.' ? '.' : toForwardSlash(root), entry });
  }

  return packages;
}

export async function loadTsConfigPathsAsync(projectRoot: string): Promise<TsConfigPaths> {
  const resolvedRoot = path.resolve(projectRoot);
  const empty: TsConfigPaths = { paths: {} };
  const tsconfigPath = path.join(resolvedRoot, 'tsconfig.json');
  const parsed = await readJsonFileAsync(tsconfigPath);
  if (!parsed) return empty;

  const compilerOptions = typeof parsed.compilerOptions === 'object' && parsed.compilerOptions !== null
    ? (parsed.compilerOptions as Record<string, unknown>)
    : {};

  let baseUrl: string | undefined;
  if (typeof compilerOptions.baseUrl === 'string') {
    baseUrl = toForwardSlash(path.relative(resolvedRoot, path.join(resolvedRoot, compilerOptions.baseUrl)));
  }

  const paths: Record<string, string[]> = {};
  const rawPaths = compilerOptions.paths;
  if (typeof rawPaths === 'object' && rawPaths !== null) {
    for (const [key, values] of Object.entries(rawPaths)) {
      if (Array.isArray(values)) {
        paths[key] = values.filter((v): v is string => typeof v === 'string');
      }
    }
  }

  return { baseUrl, paths };
}

async function tryResolveFileAsync(projectRoot: string, candidate: string): Promise<string | null> {
  const abs = path.resolve(projectRoot, candidate);
  if (await fileExists(abs)) return relativeToProject(projectRoot, abs);
  for (const ext of RESOLVE_EXTS) {
    const withExt = abs + ext;
    if (await fileExists(withExt)) return relativeToProject(projectRoot, withExt);
  }
  for (const indexFile of INDEX_FILES) {
    const indexCandidate = path.join(abs, indexFile);
    if (await fileExists(indexCandidate)) return relativeToProject(projectRoot, indexCandidate);
  }
  return null;
}

async function resolveRelativeImport(fromFile: string, specifier: string, projectRoot: string): Promise<string | null> {
  const fromDir = path.dirname(path.join(projectRoot, fromFile));
  const resolved = path.posix.normalize(path.posix.join(toForwardSlash(fromDir), specifier));
  return tryResolveFileAsync(projectRoot, resolved);
}

async function resolvePackageImportAsync(
  specifier: string,
  packageName: string,
  packageRoot: string,
  packageEntry: string | null,
  projectRoot: string
): Promise<string | null> {
  const prefix = `${packageName}/`;
  if (specifier === packageName) {
    if (packageEntry) return packageEntry;
    return tryResolveFileAsync(projectRoot, path.posix.join(packageRoot, 'index'));
  }
  if (specifier.startsWith(prefix)) {
    const subpath = specifier.slice(prefix.length);
    const candidate = path.posix.join(packageRoot, subpath);
    return tryResolveFileAsync(projectRoot, candidate);
  }
  return null;
}

async function resolveTsConfigPathAsync(
  specifier: string,
  tsConfig: TsConfigPaths,
  projectRoot: string
): Promise<string | null> {
  if (Object.keys(tsConfig.paths).length === 0) return null;
  const baseDir = tsConfig.baseUrl ? path.join(projectRoot, tsConfig.baseUrl) : projectRoot;

  for (const [pattern, targets] of Object.entries(tsConfig.paths)) {
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1);
      if (specifier.startsWith(prefix)) {
        const tail = specifier.slice(prefix.length);
        for (const target of targets) {
          const mapped = target.endsWith('/*') ? target.slice(0, -1) + tail : target;
          const resolved = await tryResolveFileAsync(projectRoot, path.posix.join(toForwardSlash(baseDir), mapped));
          if (resolved) return resolved;
        }
      }
    } else if (pattern === specifier) {
      for (const target of targets) {
        const resolved = await tryResolveFileAsync(projectRoot, path.posix.join(toForwardSlash(baseDir), target));
        if (resolved) return resolved;
      }
    }
  }

  return null;
}

export async function resolveImportToFile(
  fromFile: string,
  specifier: string,
  resolver: WorkspaceResolver
): Promise<string | null> {
  if (!specifier) return null;

  if (specifier.startsWith('.')) {
    return resolveRelativeImport(fromFile, specifier, resolver.projectRoot);
  }

  // Workspace packages
  for (const pkg of resolver.packages) {
    const resolved = await resolvePackageImportAsync(specifier, pkg.name, pkg.root, pkg.entry, resolver.projectRoot);
    if (resolved) return resolved;
  }

  // tsconfig paths
  const tsConfigResolved = await resolveTsConfigPathAsync(specifier, resolver.tsConfig, resolver.projectRoot);
  if (tsConfigResolved) return tsConfigResolved;

  return null;
}

export async function loadWorkspaceResolverAsync(projectRoot: string): Promise<WorkspaceResolver> {
  const resolvedRoot = path.resolve(projectRoot);
  const [packages, tsConfig] = await Promise.all([
    loadWorkspacePackagesAsync(resolvedRoot),
    loadTsConfigPathsAsync(resolvedRoot),
  ]);
  return { projectRoot: resolvedRoot, packages, tsConfig };
}
