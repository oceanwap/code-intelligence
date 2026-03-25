import { Project, SyntaxKind } from 'ts-morph';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

export interface CodeChunk {
  id: string;
  file: string;
  symbol: string;
  type: 'function' | 'class' | 'method' | 'file';
  code: string;
  imports: string[];
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

const MAX_PLAIN_BYTES = 32_000; // skip huge generated files

function indexPlainFiles(rootDir: string): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  const allFiles = walkFiles(rootDir, [...PLAIN_EXTS], PLAIN_NAMES);
  for (const absPath of allFiles) {
    if (!isPlainFile(absPath)) continue;
    const stat = fs.statSync(absPath);
    if (stat.size > MAX_PLAIN_BYTES) continue;
    const relPath = path.relative(rootDir, absPath);
    const code = fs.readFileSync(absPath, 'utf-8');
    chunks.push({
      id: chunkId(relPath, '<file>'),
      file: relPath,
      symbol: relPath,
      type: 'file',
      code,
      imports: [],
    });
  }
  return chunks;
}

export function indexDirectory(rootDir: string): CodeChunk[] {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true },
  });

  walkFiles(rootDir, ['.ts', '.tsx', '.js', '.jsx']).forEach(f =>
    project.addSourceFileAtPath(f)
  );

  const chunks: CodeChunk[] = [];

  for (const sf of project.getSourceFiles()) {
    const relPath = path.relative(rootDir, sf.getFilePath());
    const imports = sf.getImportDeclarations().map(d => d.getModuleSpecifierValue());

    for (const fn of sf.getFunctions()) {
      const name = fn.getName() ?? '<anonymous>';
      chunks.push({
        id: chunkId(relPath, name),
        file: relPath,
        symbol: name,
        type: 'function',
        code: fn.getText(),
        imports,
      });
    }

    for (const cls of sf.getClasses()) {
      const className = cls.getName() ?? '<anonymous>';
      chunks.push({
        id: chunkId(relPath, className),
        file: relPath,
        symbol: className,
        type: 'class',
        code: cls.getText(),
        imports,
      });

      for (const method of cls.getMethods()) {
        const sym = `${className}.${method.getName()}`;
        chunks.push({
          id: chunkId(relPath, sym),
          file: relPath,
          symbol: sym,
          type: 'method',
          code: method.getText(),
          imports,
        });
      }
    }
  }

  return [...chunks, ...indexPlainFiles(rootDir)];
}

export function walkFiles(dir: string, exts: string[], extraNames?: Set<string>): string[] {
  const SKIP = new Set(['node_modules', '.git', '.code-intelligence', 'dist']);
  const results: string[] = [];

  function readIgnorePatterns(dirPath: string): RegExp[] {
    const ignoreFile = path.join(dirPath, '.gitignore');
    if (!fs.existsSync(ignoreFile)) return [];
    return fs.readFileSync(ignoreFile, 'utf-8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(pattern => {
        // Convert gitignore glob pattern to a RegExp
        const anchored = pattern.startsWith('/');
        const p = pattern
          .replace(/^\//, '')  // strip leading slash
          .replace(/\/$/, ''); // strip trailing slash (dir-only markers — match name itself)
        const escaped = p
          .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials (except * ?)
          .replace(/\*\*/g, '\x00')              // placeholder for **
          .replace(/\*/g, '[^/]*')               // * matches within segment
          .replace(/\?/g, '[^/]')                // ? matches single char
          .replace(/\x00/g, '.*');               // ** matches across segments
        return anchored
          ? new RegExp(`^${escaped}(/|$)`)
          : new RegExp(`(^|/)${escaped}(/|$)`);
      });
  }

  function walk(currentDir: string, ignorePatterns: RegExp[]): void {
    const localPatterns = [...ignorePatterns, ...readIgnorePatterns(currentDir)];
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const relToRoot = path.relative(dir, path.join(currentDir, entry.name)).replace(/\\/g, '/');
      if (localPatterns.some(re => re.test(relToRoot))) continue;
      const full = path.join(currentDir, entry.name);
      if (entry.isDirectory()) walk(full, localPatterns);
      else if (exts.includes(path.extname(entry.name)) || extraNames?.has(entry.name)) results.push(full);
    }
  }

  walk(dir, []);
  return results;
}

// --- Differential index manifest ---

export interface Manifest {
  /** relPath → last-seen mtime in ms */
  mtimes: Record<string, number>;
  /** relPath → chunk IDs extracted from that file */
  fileChunks: Record<string, string[]>;
}

export function loadManifest(manifestFile: string): Manifest {
  if (!fs.existsSync(manifestFile)) return { mtimes: {}, fileChunks: {} };
  return JSON.parse(fs.readFileSync(manifestFile, 'utf-8')) as Manifest;
}

export function saveManifest(manifest: Manifest, manifestFile: string): void {
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
}

/** Build a fresh manifest from the current state of the directory + extracted chunks */
export function buildManifest(rootDir: string, chunks: CodeChunk[]): Manifest {
  // Derive mtimes from every indexed file (all types: AST + plain)
  // Using chunks as the source means mtimes covers exactly what is indexed.
  const seen = new Set<string>();
  const mtimes: Record<string, number> = {};
  const fileChunks: Record<string, string[]> = {};
  for (const c of chunks) {
    (fileChunks[c.file] ??= []).push(c.id);
    if (!seen.has(c.file)) {
      seen.add(c.file);
      const abs = path.join(rootDir, c.file);
      if (fs.existsSync(abs)) mtimes[c.file] = fs.statSync(abs).mtimeMs;
    }
  }
  return { mtimes, fileChunks };
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
