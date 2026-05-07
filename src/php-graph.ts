/**
 * PHP call graph builder.
 * Extracts outbound calls and inbound callers for PHP functions/methods.
 */
import * as path from 'path';
import * as fs from 'fs';
import { createRequire } from 'module';
import { walkFiles } from './indexer.js';
import type { GraphCallSite, GraphData } from './graph.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const phpParserPkg = require('php-parser') as any;
const Engine: new (opts: unknown) => PhpEngine =
  phpParserPkg.Engine ?? phpParserPkg.default?.Engine ?? phpParserPkg;

interface Node {
  kind: string;
  loc?: {
    start?: { line: number };
    end?: { line: number };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

interface PhpEngine {
  parseCode(code: string, filename: string): Node;
}

type TypeMembers = Record<string, Set<string>>;

function addUnique(target: Record<string, string[]>, key: string, value: string): void {
  if (!key || !value) return;
  const entries = (target[key] ??= []);
  if (!entries.includes(value)) entries.push(value);
}

function normalizePhpType(name: string | null | undefined, nsPrefix: string, imports: string[]): string | null {
  if (!name) return null;
  const trimmed = name.replace(/^\\/, '').trim();
  if (!trimmed) return null;
  if (trimmed.includes('\\')) return trimmed;
  const imported = imports.find(entry => entry === trimmed || entry.endsWith(`\\${trimmed}`));
  if (imported) return imported.replace(/^\\/, '');
  return nsPrefix ? `${nsPrefix}${trimmed}` : trimmed;
}

function normalizePhpTypes(values: Array<string | null | undefined>, nsPrefix: string, imports: string[]): string[] {
  const refs = new Set<string>();
  for (const value of values) {
    const normalized = normalizePhpType(value, nsPrefix, imports);
    if (normalized) refs.add(normalized);
  }
  return [...refs];
}

function asPhpNodeList(value: unknown): Array<Node | string | null | undefined> {
  if (Array.isArray(value)) return value as Array<Node | string | null | undefined>;
  if (value === null || value === undefined) return [];
  return [value as Node | string | null | undefined];
}

function registerSupertypes(graph: GraphData, typeName: string, supertypes: string[]): void {
  if (supertypes.length > 0) {
    graph.supertypes[typeName] = supertypes;
  }
  for (const supertype of supertypes) {
    addUnique(graph.subtypes, supertype, typeName);
  }
}

function collectAllSupertypes(typeName: string, directSupertypes: Record<string, string[]>, seen = new Set<string>()): string[] {
  for (const supertype of directSupertypes[typeName] ?? []) {
    if (seen.has(supertype)) continue;
    seen.add(supertype);
    collectAllSupertypes(supertype, directSupertypes, seen);
  }
  return [...seen];
}

function registerImplementation(graph: GraphData, baseSymbol: string, implementationSymbol: string): void {
  addUnique(graph.implementations, baseSymbol, implementationSymbol);
  addUnique(graph.implementedFrom, implementationSymbol, baseSymbol);
}

function makeParser(): PhpEngine {
  return new Engine({
    parser: { extractDoc: false, suppressErrors: true },
    ast: { withPositions: true },
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

/** Collect all call expressions within a subtree, returning callee callsite entries */
function extractPhpCalls(node: Node, relPath: string): GraphCallSite[] {
  const calls: GraphCallSite[] = [];
  walk(node, n => {
    if (n.kind !== 'call') return;
    const what = n.what as Node | undefined;
    if (!what) return;
    const line = n.loc?.start?.line ?? what.loc?.start?.line ?? 1;

    // Plain function call: foo()
    if (what.kind === 'identifier' || what.kind === 'name') {
      const name = nodeName(what);
      if (name) calls.push({ symbol: name, file: relPath, line });
    }

    // Static call: ClassName::method()  or  self::method()
    if (what.kind === 'staticlookup') {
      const className = nodeName(what.what);
      const methodName = nodeName(what.offset);
      if (methodName) {
        if (className && className !== 'self' && className !== 'static' && className !== 'parent') {
          calls.push({ symbol: `${className}::${methodName}`, file: relPath, line });
        } else {
          calls.push({ symbol: methodName, file: relPath, line });
        }
      }
    }

    // Instance call: $this->method() or $obj->method()
    if (what.kind === 'propertylookup') {
      const methodName = nodeName(what.offset);
      const obj = what.what as Node | undefined;
      if (methodName) {
        if (obj?.kind === 'variable' && (obj.name === 'this' || obj.name === 'self')) {
          calls.push({ symbol: methodName, file: relPath, line }); // resolved further if we know the class name at call site
        } else {
          calls.push({ symbol: methodName, file: relPath, line });
        }
      }
    }
  });
  return calls;
}

export function buildPhpGraph(rootDir: string, graph: GraphData): void {
  const files = walkFiles(rootDir, ['.php']);
  const typeMembers: TypeMembers = Object.create(null) as TypeMembers;
  const typeNames = new Set<string>();

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
          const calls = extractPhpCalls(n.body ?? n, relPath);
          graph.symbols[fullName] = [...new Set([...(graph.symbols[fullName] ?? []), ...calls.map(call => call.symbol)])];
          for (const call of calls) {
            (graph.callSites![fullName] ??= []);
            if (!graph.callSites![fullName].some(entry => entry.symbol === call.symbol && entry.file === call.file && entry.line === call.line)) {
              graph.callSites![fullName].push(call);
            }
          }
          graph.symbolFile[fullName] = relPath;
          for (const callee of calls) {
            (graph.callers[callee.symbol] ??= []);
            if (!graph.callers[callee.symbol].includes(fullName)) graph.callers[callee.symbol].push(fullName);
            (graph.calledBySites![callee.symbol] ??= []);
            if (!graph.calledBySites![callee.symbol].some(entry => entry.symbol === fullName && entry.file === relPath && entry.line === callee.line)) {
              graph.calledBySites![callee.symbol].push({ symbol: fullName, file: relPath, line: callee.line });
            }
          }
        }

        // Classes / interfaces / traits
        if (n.kind === 'class' || n.kind === 'interface' || n.kind === 'trait') {
          const className = nodeName(n.name);
          if (!className) continue;
          const fullClassName = `${nsPrefix}${className}`;
          graph.symbolFile[fullClassName] = relPath;
          typeNames.add(fullClassName);

          const directSupertypes = normalizePhpTypes([
            ...asPhpNodeList(n.extends).map(entry => nodeName(entry)),
            ...asPhpNodeList(n.implements).map(entry => nodeName(entry)),
          ], nsPrefix, fileImports);
          registerSupertypes(graph, fullClassName, directSupertypes);

          const body: Node[] = n.body ?? [];
          typeMembers[fullClassName] = new Set(
            body
              .filter(member => member.kind === 'method')
              .map(member => nodeName(member.name))
              .filter((name): name is string => Boolean(name))
          );
          for (const member of body) {
            if (member.kind !== 'method') continue;
            const methodName = nodeName(member.name);
            if (!methodName) continue;
            const sym = `${fullClassName}::${methodName}`;
            const calls = extractPhpCalls(member.body ?? member, relPath);
            // Qualify $this->foo() as ClassName::foo when possible
            const qualifiedCalls = calls.map(c =>
              // If bare name and there's a method of same name in the class, qualify it
              !c.symbol.includes('::') && !c.symbol.includes('\\') &&
              body.some(m => m.kind === 'method' && nodeName(m.name) === c.symbol)
                ? { ...c, symbol: `${fullClassName}::${c.symbol}` }
                : c
            );
            graph.symbols[sym] = [...new Set([...(graph.symbols[sym] ?? []), ...qualifiedCalls.map(call => call.symbol)])];
            for (const call of qualifiedCalls) {
              (graph.callSites![sym] ??= []);
              if (!graph.callSites![sym].some(entry => entry.symbol === call.symbol && entry.file === call.file && entry.line === call.line)) {
                graph.callSites![sym].push(call);
              }
            }
            graph.symbolFile[sym] = relPath;
            for (const callee of qualifiedCalls) {
              (graph.callers[callee.symbol] ??= []);
              if (!graph.callers[callee.symbol].includes(sym)) graph.callers[callee.symbol].push(sym);
              (graph.calledBySites![callee.symbol] ??= []);
              if (!graph.calledBySites![callee.symbol].some(entry => entry.symbol === sym && entry.file === relPath && entry.line === callee.line)) {
                graph.calledBySites![callee.symbol].push({ symbol: sym, file: relPath, line: callee.line });
              }
            }
          }
        }
      }
    }
  }

  for (const typeName of typeNames) {
    const allSupertypes = collectAllSupertypes(typeName, graph.supertypes);

    for (const supertype of allSupertypes) {
      registerImplementation(graph, supertype, typeName);
    }

    for (const memberName of typeMembers[typeName] ?? []) {
      const implementationSymbol = `${typeName}::${memberName}`;
      for (const supertype of allSupertypes) {
        if (!(typeMembers[supertype]?.has(memberName))) continue;
        registerImplementation(graph, `${supertype}::${memberName}`, implementationSymbol);
      }
    }
  }
}
