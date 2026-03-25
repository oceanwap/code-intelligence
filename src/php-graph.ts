/**
 * PHP call graph builder.
 * Extracts outbound calls and inbound callers for PHP functions/methods.
 */
import * as path from 'path';
import * as fs from 'fs';
import { createRequire } from 'module';
import { walkFiles } from './indexer.js';
import type { GraphData } from './graph.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const phpParserPkg = require('php-parser') as any;
const Engine: new (opts: unknown) => PhpEngine =
  phpParserPkg.Engine ?? phpParserPkg.default?.Engine ?? phpParserPkg;

interface Node {
  kind: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

interface PhpEngine {
  parseCode(code: string, filename: string): Node;
}

function makeParser(): PhpEngine {
  return new Engine({
    parser: { extractDoc: false, suppressErrors: true },
    ast: { withPositions: false },
    lexer: { all_tokens: false },
  });
}

function nodeName(n: Node | string | null | undefined): string | null {
  if (!n) return null;
  if (typeof n === 'string') return n;
  if (n.kind === 'identifier' || n.kind === 'name') return n.name as string;
  return null;
}

function walk(node: Node, visitor: (n: Node) => void): void {
  if (!node || typeof node !== 'object') return;
  visitor(node);
  for (const val of Object.values(node)) {
    if (Array.isArray(val)) val.forEach(v => walk(v as Node, visitor));
    else if (val && typeof val === 'object' && 'kind' in (val as object)) walk(val as Node, visitor);
  }
}

/** Collect all call expressions within a subtree, returning callee name strings */
function extractPhpCalls(node: Node): string[] {
  const calls = new Set<string>();
  walk(node, n => {
    if (n.kind !== 'call') return;
    const what = n.what as Node | undefined;
    if (!what) return;

    // Plain function call: foo()
    if (what.kind === 'identifier' || what.kind === 'name') {
      const name = nodeName(what);
      if (name) calls.add(name);
    }

    // Static call: ClassName::method()  or  self::method()
    if (what.kind === 'staticlookup') {
      const className = nodeName(what.what);
      const methodName = nodeName(what.offset);
      if (methodName) {
        if (className && className !== 'self' && className !== 'static' && className !== 'parent') {
          calls.add(`${className}::${methodName}`);
        } else {
          calls.add(methodName);
        }
      }
    }

    // Instance call: $this->method() or $obj->method()
    if (what.kind === 'propertylookup') {
      const methodName = nodeName(what.offset);
      const obj = what.what as Node | undefined;
      if (methodName) {
        if (obj?.kind === 'variable' && (obj.name === 'this' || obj.name === 'self')) {
          calls.add(methodName); // resolved further if we know the class name at call site
        } else {
          calls.add(methodName);
        }
      }
    }
  });
  return [...calls];
}

export function buildPhpGraph(rootDir: string, graph: GraphData): void {
  const files = walkFiles(rootDir, ['.php']);

  for (const absPath of files) {
    const relPath = path.relative(rootDir, absPath);
    let src: string;
    try {
      src = fs.readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }

    const parser = makeParser();
    let ast: Node;
    try {
      ast = parser.parseCode(src, relPath);
    } catch {
      continue;
    }

    // Collect imports from use statements for the file entry
    const fileImports: string[] = [];
    walk(ast, n => {
      if (n.kind === 'usegroup') {
        const items: Node[] = n.items ?? [];
        for (const item of items) {
          if (item.name) fileImports.push(item.name as string);
        }
      }
    });
    graph.files[relPath] = fileImports;

    // Flatten namespace wrappers
    const topLevel: Node[] = ast.kind === 'program' ? (ast.children ?? []) : [];
    const containers: Array<{ children: Node[]; nsPrefix: string }> = [];

    for (const n of topLevel) {
      if (n.kind === 'namespace') {
        const nsName = nodeName(n.name) ?? '';
        containers.push({ children: n.children ?? [], nsPrefix: nsName ? `${nsName}\\` : '' });
      } else {
        if (containers.length === 0 || containers[0].nsPrefix !== '') {
          containers.unshift({ children: [], nsPrefix: '' });
        }
        containers[0].children.push(n);
      }
    }

    for (const { children, nsPrefix } of containers) {
      for (const n of children) {
        // Top-level functions
        if (n.kind === 'function') {
          const name = nodeName(n.name);
          if (!name) continue;
          const fullName = `${nsPrefix}${name}`;
          const calls = extractPhpCalls(n.body ?? n);
          graph.symbols[fullName] = [...new Set([...(graph.symbols[fullName] ?? []), ...calls])];
          graph.symbolFile[fullName] = relPath;
          for (const callee of calls) {
            (graph.callers[callee] ??= []);
            if (!graph.callers[callee].includes(fullName)) graph.callers[callee].push(fullName);
          }
        }

        // Classes / interfaces / traits
        if (n.kind === 'class' || n.kind === 'interface' || n.kind === 'trait') {
          const className = nodeName(n.name);
          if (!className) continue;
          const fullClassName = `${nsPrefix}${className}`;
          graph.symbolFile[fullClassName] = relPath;

          const body: Node[] = n.body ?? [];
          for (const member of body) {
            if (member.kind !== 'method') continue;
            const methodName = nodeName(member.name);
            if (!methodName) continue;
            const sym = `${fullClassName}::${methodName}`;
            const calls = extractPhpCalls(member.body ?? member);
            // Qualify $this->foo() as ClassName::foo when possible
            const qualifiedCalls = calls.map(c =>
              // If bare name and there's a method of same name in the class, qualify it
              !c.includes('::') && !c.includes('\\') &&
              body.some(m => m.kind === 'method' && nodeName(m.name) === c)
                ? `${fullClassName}::${c}`
                : c
            );
            graph.symbols[sym] = [...new Set([...(graph.symbols[sym] ?? []), ...qualifiedCalls])];
            graph.symbolFile[sym] = relPath;
            for (const callee of qualifiedCalls) {
              (graph.callers[callee] ??= []);
              if (!graph.callers[callee].includes(sym)) graph.callers[callee].push(sym);
            }
          }
        }
      }
    }
  }
}
