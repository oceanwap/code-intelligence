/**
 * PHP AST indexer using php-parser (glayzzle).
 * Extracts functions, classes, and methods as CodeChunk entries.
 */
import * as path from 'path';
import * as fs from 'fs';
import { createRequire } from 'module';
import type { CodeChunk } from './indexer.js';
import { chunkId } from './indexer.js';
import { walkFiles } from './indexer.js';

// php-parser is CJS; use createRequire so we stay ESM-compatible
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const phpParserPkg = require('php-parser') as any;
const Engine: new (opts: unknown) => PhpEngine =
  phpParserPkg.Engine ?? phpParserPkg.default?.Engine ?? phpParserPkg;

// ---- Minimal type surface for php-parser AST nodes ----------------

interface Loc {
  start: { line: number; offset: number };
  end: { line: number; offset: number };
}

interface Node {
  kind: string;
  loc?: Loc;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

interface PhpEngine {
  parseCode(code: string, filename: string): Node;
}

// -------------------------------------------------------------------

function makeParser(): PhpEngine {
  return new Engine({
    parser: { extractDoc: true, suppressErrors: true },
    ast: { withPositions: true },
    lexer: { all_tokens: false },
  });
}

/** Extract the string name from an identifier or string AST node */
function nodeName(n: Node | string | null | undefined): string | null {
  if (!n) return null;
  if (typeof n === 'string') return n;
  if (n.kind === 'identifier' || n.kind === 'name') return n.name as string;
  return null;
}

/** Slice source lines [startLine, endLine] (1-based, inclusive) */
function sliceLines(lines: string[], start: number, end: number): string {
  return lines.slice(start - 1, end).join('\n');
}

/** Recursively walk any node, calling visitor for every node in the tree */
function walk(node: Node, visitor: (n: Node) => void): void {
  if (!node || typeof node !== 'object') return;
  visitor(node);
  for (const val of Object.values(node)) {
    if (Array.isArray(val)) val.forEach(v => walk(v as Node, visitor));
    else if (val && typeof val === 'object' && 'kind' in val) walk(val as Node, visitor);
  }
}

/** Collect `use` imports from a program/namespace children list */
function collectImports(children: Node[]): string[] {
  const imports: string[] = [];
  for (const n of children) {
    if (n.kind === 'usegroup') {
      const items: Node[] = n.items ?? [];
      for (const item of items) {
        if (item.name) imports.push(item.name as string);
      }
    }
  }
  return imports;
}

export function indexPhpFiles(rootDir: string): CodeChunk[] {
  const files = walkFiles(rootDir, ['.php']);
  const chunks: CodeChunk[] = [];

  for (const absPath of files) {
    const relPath = path.relative(rootDir, absPath);
    let src: string;
    try {
      src = fs.readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }

    const lines = src.split('\n');
    const parser = makeParser();

    let ast: Node;
    try {
      ast = parser.parseCode(src, relPath);
    } catch {
      // Fall back to whole-file plain chunk when parsing fails
      chunks.push({
        id: chunkId(relPath, '<file>'),
        file: relPath,
        symbol: relPath,
        type: 'file',
        code: src.slice(0, 32_000),
        imports: [],
      });
      continue;
    }

    // Flatten namespace wrappers so we handle namespaced and global code uniformly
    const topLevel: Node[] = ast.kind === 'program' ? (ast.children ?? []) : [];
    const containers: Array<{ children: Node[]; nsPrefix: string }> = [];

    for (const n of topLevel) {
      if (n.kind === 'namespace') {
        const nsName = nodeName(n.name) ?? '';
        containers.push({ children: n.children ?? [], nsPrefix: nsName ? `${nsName}\\` : '' });
      } else {
        // global scope
        if (containers.length === 0 || containers[0].nsPrefix !== '') {
          containers.unshift({ children: [], nsPrefix: '' });
        }
        containers[0].children.push(n);
      }
    }

    for (const { children, nsPrefix } of containers) {
      const imports = collectImports(children);

      for (const n of children) {
        // Top-level functions
        if (n.kind === 'function') {
          const name = nodeName(n.name);
          if (!name) continue;
          const fullName = `${nsPrefix}${name}`;
          const loc = n.loc;
          chunks.push({
            id: chunkId(relPath, fullName),
            file: relPath,
            symbol: fullName,
            type: 'function',
            code: loc ? sliceLines(lines, loc.start.line, loc.end.line) : `function ${name}(...) { ... }`,
            imports,
          });
        }

        // Classes, abstract classes, interfaces, traits
        if (n.kind === 'class' || n.kind === 'interface' || n.kind === 'trait') {
          const className = nodeName(n.name);
          if (!className) continue;
          const fullClassName = `${nsPrefix}${className}`;
          const classLoc = n.loc;

          chunks.push({
            id: chunkId(relPath, fullClassName),
            file: relPath,
            symbol: fullClassName,
            type: 'class',
            code: classLoc ? sliceLines(lines, classLoc.start.line, classLoc.end.line) : `class ${className} { ... }`,
            imports,
          });

          // Methods
          const body: Node[] = n.body ?? [];
          for (const member of body) {
            if (member.kind !== 'method') continue;
            const methodName = nodeName(member.name);
            if (!methodName) continue;
            const sym = `${fullClassName}::${methodName}`;
            const mLoc = member.loc;
            chunks.push({
              id: chunkId(relPath, sym),
              file: relPath,
              symbol: sym,
              type: 'method',
              code: mLoc ? sliceLines(lines, mLoc.start.line, mLoc.end.line) : `public function ${methodName}(...) { ... }`,
              imports,
            });
          }
        }
      }
    }
  }

  return chunks;
}
