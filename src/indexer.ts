import { Project, type Node as MorphNode, type SourceFile, SyntaxKind } from 'ts-morph';
import * as path from 'path';
import * as crypto from 'crypto';
import { indexPhpFilesAsync } from './php-indexer.js';

export interface CodeChunk {
  id: string;
  file: string;
  symbol: string;
  type: 'function' | 'class' | 'method' | 'file';
  code: string;
  imports: string[];
  lineStart: number;
  lineEnd: number;
}

export type IndexingMode = 'fast' | 'full';
export interface IndexDirectoryOptions {
  mode?: IndexingMode;
  includeFiles?: Set<string>;
}

// Extensions indexed as whole-file plain-text chunks (no AST)
const PLAIN_EXTS = new Set([
  '.json', '.yaml', '.yml', '.toml', '.sh', '.bash',
  '.dockerfile', '.conf', '.ini', '.xml', '.md', '.mdx',
]);
const PLAIN_NAMES = new Set([
  'Makefile', 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  '.dockerignore', '.gitignore', '.npmrc', '.nvmrc', '.editorconfig',
]);
// Never index files that may contain secrets
const SECRET_NAMES = new Set(['.env', '.env.local', '.env.production', '.env.development']);

function isPlainFile(filePath: string): boolean {
  const base = path.basename(filePath);
  if (SECRET_NAMES.has(base) || base.startsWith('.env')) return false;
  return PLAIN_NAMES.has(base) || PLAIN_EXTS.has(path.extname(filePath).toLowerCase());
}

function isTestLikePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').toLowerCase();
  const base = path.basename(normalized);
  return normalized.startsWith('test/')
    || normalized.startsWith('tests/')
    || normalized.startsWith('__tests__/')
    || normalized.includes('/__tests__/')
    || /\.(test|spec)\.[a-z0-9]+$/.test(base);
}

interface WalkFilters {
  gitignoreInclude: RegExp[];
  gitignoreExclude: RegExp[];
  tsInclude: RegExp[];
  tsExclude: RegExp[];
}

const walkFilterCache = new Map<string, WalkFilters>();

export function stripJsonComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegExp(glob: string): RegExp {
  let normalized = glob.trim().replace(/^\.\//, '').replace(/\\/g, '/');
  normalized = normalized.replace(/^\//, '');
  
  // If pattern ends with /, it's a directory pattern - match dir and everything in it
  if (normalized.endsWith('/')) normalized = `${normalized}**`;

  // Handle ** patterns by splitting and reconstructing
  let source = '';
  let remaining = normalized;
  
  while (remaining) {
    const doubleStarIdx = remaining.indexOf('**');
    
    if (doubleStarIdx === -1) {
      // No more ** patterns, process the rest
      source += remaining
        .split('*')
        .map(escapeRegex)
        .join('[^/]*')
        .replace(/\?/g, '[^/]');
      break;
    }
    
    // Process everything before **
    const before = remaining.substring(0, doubleStarIdx);
    source += before
      .split('*')
      .map(escapeRegex)
      .join('[^/]*')
      .replace(/\?/g, '[^/]');
    
    // Skip the **
    remaining = remaining.substring(doubleStarIdx + 2);
    
    // Handle **/ and /** patterns
    if (remaining.startsWith('/')) {
      // **/ means zero or more path segments followed by /
      source += '(?:.*/)?';
      remaining = remaining.substring(1);
    } else if (before.endsWith('/')) {
      // Pattern is like foo/** (match everything under foo/)
      source += '.*';
    } else {
      // Pattern is like foo** with no surrounding slashes (rare, treat as .*/)
      source += '(?:.*/)?';
    }
  }

  return new RegExp(`^${source}$`);
}

async function parseGitignorePatterns(rootDir: string): Promise<{ include: RegExp[]; exclude: RegExp[] }> {
  const ignoreFile = path.join(rootDir, '.gitignore');
  try {
    const file = Bun.file(ignoreFile);
    if (!(await file.exists())) return { include: [], exclude: [] };
    const content = await file.text();
    const lines = content.split(/\r?\n/);
    const includePatterns: RegExp[] = [];
    const excludePatterns: RegExp[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      
      // Handle negation patterns (un-ignore)
      if (trimmed.startsWith('!')) {
        const raw = trimmed.slice(1).replace(/^\//, '');
        if (!raw) continue;
        
        if (!raw.includes('/')) {
          excludePatterns.push(globToRegExp(`**/${raw}`));
          excludePatterns.push(new RegExp(`(^|/)${escapeRegex(raw)}($|/)`));
        } else {
          excludePatterns.push(globToRegExp(raw));
        }
        continue;
      }
      
      // Handle positive patterns (ignore)
      const raw = trimmed.replace(/^\//, '');
      if (!raw.includes('/')) {
        includePatterns.push(globToRegExp(`**/${raw}`));
        includePatterns.push(new RegExp(`(^|/)${escapeRegex(raw)}($|/)`));
      } else {
        includePatterns.push(globToRegExp(raw));
      }
    }

    return { include: includePatterns, exclude: excludePatterns };
  } catch {
    return { include: [], exclude: [] };
  }
}

async function parseTsConfigFilters(rootDir: string): Promise<{ include: RegExp[]; exclude: RegExp[] }> {
  const tsconfigPath = path.join(rootDir, 'tsconfig.json');
  try {
    const file = Bun.file(tsconfigPath);
    if (!(await file.exists())) return { include: [], exclude: [] };
    const raw = await file.text();
    const parsed = JSON.parse(stripJsonComments(raw)) as {
      include?: string[];
      exclude?: string[];
      files?: string[];
    };

    // Only filter by tsconfig if include/files patterns are explicitly specified
    const hasIncludePatterns = (parsed.include?.length ?? 0) > 0 || (parsed.files?.length ?? 0) > 0;
    
    const includeGlobs = hasIncludePatterns ? [
      ...(parsed.include ?? []),
      ...((parsed.files ?? []).map(file => file.replace(/\\/g, '/'))),
    ].map(glob => globToRegExp(glob)) : [];

    const excludeGlobs = (parsed.exclude ?? []).map(glob => globToRegExp(glob));
    return { include: includeGlobs, exclude: excludeGlobs };
  } catch {
    return { include: [], exclude: [] };
  }
}

async function getWalkFilters(rootDir: string): Promise<WalkFilters> {
  const key = path.resolve(rootDir);
  const cached = walkFilterCache.get(key);
  if (cached) return cached;

  const gitignorePatterns = await parseGitignorePatterns(key);
  const tsconfig = await parseTsConfigFilters(key);
  const filters: WalkFilters = {
    gitignoreInclude: gitignorePatterns.include,
    gitignoreExclude: gitignorePatterns.exclude,
    tsInclude: tsconfig.include,
    tsExclude: tsconfig.exclude,
  };

  walkFilterCache.set(key, filters);
  return filters;
}

function shouldFilterByGitignore(relPath: string, filters: WalkFilters): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  // First check if explicitly un-ignored (negation pattern)
  if (filters.gitignoreExclude.some(re => re.test(normalized))) return false;
  // Then check if ignored
  return filters.gitignoreInclude.some(re => re.test(normalized));
}

function shouldFilterByTsConfig(relPath: string, filters: WalkFilters): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  if (filters.tsExclude.some(re => re.test(normalized))) return true;
  if (filters.tsInclude.length === 0) return false;
  return !filters.tsInclude.some(re => re.test(normalized));
}

const MAX_PLAIN_BYTES = 32_000; // skip huge generated files

function lineRangeForNode(sourceFile: SourceFile, node: MorphNode): { lineStart: number; lineEnd: number } {
  return {
    lineStart: sourceFile.getLineAndColumnAtPos(node.getStart()).line,
    lineEnd: sourceFile.getLineAndColumnAtPos(node.getEnd()).line,
  };
}

function lineRangeForText(text: string): { lineStart: number; lineEnd: number } {
  return {
    lineStart: 1,
    lineEnd: Math.max(1, text.split('\n').length),
  };
}

function isLowSignalPathForFast(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').toLowerCase();
  return normalized.startsWith('test/')
    || normalized.startsWith('tests/')
    || normalized.startsWith('docs/')
    || normalized.startsWith('examples/')
    || normalized.startsWith('scripts/')
    || normalized.includes('/fixtures/')
    || normalized.includes('/__snapshots__/')
    || normalized.endsWith('.snap');
}

function isHighValuePlainFile(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').toLowerCase();
  return normalized === 'readme.md'
    || normalized === 'package.json'
    || normalized === 'tsconfig.json'
    || normalized === 'dockerfile'
    || normalized.endsWith('/dockerfile');
}

async function indexPlainFilesAsync(rootDir: string, mode: IndexingMode, includeFiles?: Set<string>): Promise<CodeChunk[]> {
  const chunks: CodeChunk[] = [];
  const allFiles = await walkFiles(rootDir, [...PLAIN_EXTS], PLAIN_NAMES);
  for (const absPath of allFiles) {
    if (!isPlainFile(absPath)) continue;
    const relPath = path.relative(rootDir, absPath);
    if (includeFiles && !includeFiles.has(relPath)) continue;
    if (mode === 'fast' && (isLowSignalPathForFast(relPath) || !isHighValuePlainFile(relPath))) continue;
    const file = Bun.file(absPath);
    try {
      if (!(await file.exists())) continue;
    } catch {
      continue;
    }
    if (file.size > MAX_PLAIN_BYTES) continue;
    let code = '';
    try {
      code = await file.text();
    } catch {
      continue;
    }
    chunks.push({
      id: chunkId(relPath, '<file>'),
      file: relPath,
      symbol: relPath,
      type: 'file',
      code,
      imports: [],
      ...lineRangeForText(code),
    });
  }
  return chunks;
}

export async function indexDirectory(rootDir: string, options?: IndexDirectoryOptions): Promise<CodeChunk[]> {
  const mode = options?.mode ?? 'full';
  const includeFiles = options?.includeFiles;
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true },
  });

  const tsFiles = await walkFiles(rootDir, ['.ts', '.tsx', '.js', '.jsx']);
  tsFiles.forEach(f => {
    const relPath = path.relative(rootDir, f);
    if (includeFiles && !includeFiles.has(relPath)) return;
    if (mode === 'fast' && isLowSignalPathForFast(relPath)) return;
    project.addSourceFileAtPath(f);
  });

  const chunks: CodeChunk[] = [];

  for (const sf of project.getSourceFiles()) {
    const relPath = path.relative(rootDir, sf.getFilePath());
    const imports = sf.getImportDeclarations().map(d => d.getModuleSpecifierValue());

    for (const fn of sf.getFunctions()) {
      const name = fn.getName() ?? '<anonymous>';
      const range = lineRangeForNode(sf, fn);
      chunks.push({
        id: chunkId(relPath, name),
        file: relPath,
        symbol: name,
        type: 'function',
        code: fn.getText(),
        imports,
        ...range,
      });
    }

    for (const cls of sf.getClasses()) {
      const className = cls.getName() ?? '<anonymous>';
      const classRange = lineRangeForNode(sf, cls);
      chunks.push({
        id: chunkId(relPath, className),
        file: relPath,
        symbol: className,
        type: 'class',
        code: cls.getText(),
        imports,
        ...classRange,
      });

      for (const method of cls.getMethods()) {
        const sym = `${className}.${method.getName()}`;
        const methodRange = lineRangeForNode(sf, method);
        chunks.push({
          id: chunkId(relPath, sym),
          file: relPath,
          symbol: sym,
          type: 'method',
          code: method.getText(),
          imports,
          ...methodRange,
        });
      }
    }
  }

  const phpChunks = (await indexPhpFilesAsync(rootDir, { includeFiles })).filter(chunk => mode === 'full' || !isLowSignalPathForFast(chunk.file));
  return [...chunks, ...phpChunks, ...(await indexPlainFilesAsync(rootDir, mode, includeFiles))];
}

export async function listIndexableFiles(rootDir: string): Promise<string[]> {
  const tsJs = await walkFiles(rootDir, ['.ts', '.tsx', '.js', '.jsx']);
  const php = await walkFiles(rootDir, ['.php']);
  const plain = (await walkFiles(rootDir, [...PLAIN_EXTS], PLAIN_NAMES)).filter(isPlainFile);
  return [...new Set([...tsJs, ...php, ...plain])];
}

export async function walkFiles(dir: string, exts: string[], extraNames?: Set<string>): Promise<string[]> {
  const SKIP = new Set([
    'node_modules',
    '.git',
    '.code-intelligence',
    'dist',
    'build',
    'coverage',
    '.next',
    '.nuxt',
    '.svelte-kit',
    '.turbo',
    '.cache',
    '.parcel-cache',
    '.vercel',
    '.expo',
    'out',
    'target',
    'tmp',
    'temp',
  ]);
  const results: string[] = [];
  const filters = await getWalkFilters(dir);

  const glob = new Bun.Glob('**/*');
  for (const rel of glob.scanSync({ cwd: dir, onlyFiles: true, dot: true })) {
    const relPath = rel.replace(/\\/g, '/');
    if ([...SKIP].some(skip => relPath === skip || relPath.startsWith(`${skip}/`))) continue;
    if (shouldFilterByGitignore(relPath, filters)) continue;
    if (shouldFilterByTsConfig(relPath, filters)) continue;
    if (isTestLikePath(relPath)) continue;
    const base = path.basename(relPath);
    if (exts.includes(path.extname(base)) || extraNames?.has(base)) {
      results.push(path.join(dir, relPath));
    }
  }

  return results;
}

// --- Differential index manifest ---

export interface Manifest {
  /** ISO timestamp when the index manifest was written */
  indexedAt?: string;
  /** relPath → last-seen mtime in ms */
  mtimes: Record<string, number>;
  /** relPath → chunk IDs extracted from that file */
  fileChunks: Record<string, string[]>;
}

export async function loadManifestAsync(manifestFile: string): Promise<Manifest> {
  try {
    const file = Bun.file(manifestFile);
    if (!(await file.exists())) return { mtimes: {}, fileChunks: {} };
    return JSON.parse(await file.text()) as Manifest;
  } catch {
    return { mtimes: {}, fileChunks: {} };
  }
}

export async function saveManifestAsync(manifest: Manifest, manifestFile: string): Promise<void> {
  await Bun.write(manifestFile, JSON.stringify(manifest));
}

/** Build a fresh manifest from the current state of the directory + extracted chunks */
export async function buildManifestAsync(rootDir: string, chunks: CodeChunk[]): Promise<Manifest> {
  const seen = new Set<string>();
  const mtimes: Record<string, number> = {};
  const fileChunks: Record<string, string[]> = {};
  for (const c of chunks) {
    (fileChunks[c.file] ??= []).push(c.id);
    if (seen.has(c.file)) continue;
    seen.add(c.file);
    const abs = path.join(rootDir, c.file);
    try {
      const file = Bun.file(abs);
      if (await file.exists()) mtimes[c.file] = file.lastModified;
    } catch {
      // ignore missing files during differential manifest building
    }
  }
  return { indexedAt: new Date().toISOString(), mtimes, fileChunks };
}

// 32-char hex id derived from file path + symbol name
export function chunkId(file: string, symbol: string): string {
  return crypto
    .createHash('sha256')
    .update(`${file}::${symbol}`)
    .digest('hex')
    .slice(0, 32);
}

// Format 32-char hex as UUID for Qdrant point IDs
export function toUUID(hexId: string): string {
  return `${hexId.slice(0, 8)}-${hexId.slice(8, 12)}-${hexId.slice(12, 16)}-${hexId.slice(16, 20)}-${hexId.slice(20, 32)}`;
}
