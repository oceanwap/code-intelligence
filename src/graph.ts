import { Project, SyntaxKind, Node, FunctionDeclaration, ArrowFunction, FunctionExpression, MethodDeclaration } from 'ts-morph';
import * as path from 'path';
import * as fs from 'fs';
import { walkFiles } from './indexer.js';
import { buildPhpGraph } from './php-graph.js';

export interface GraphData {
  /** symbol name → list of called symbol names (outbound) */
  symbols: Record<string, string[]>;
  /** symbol name → list of symbol names that call it (inbound/callers) */
  callers: Record<string, string[]>;
  /** relative file path → list of import specifiers */
  files: Record<string, string[]>;
  /** symbol name → relative file path it lives in */
  symbolFile: Record<string, string>;
}

type FnLike = FunctionDeclaration | ArrowFunction | FunctionExpression | MethodDeclaration;

/** Extract a display name for any function-like node */
function getFnName(node: FnLike, parentName?: string): string | null {
  if (Node.isFunctionDeclaration(node)) return node.getName() ?? null;
  if (Node.isMethodDeclaration(node)) {
    const cls = node.getParentIfKind(SyntaxKind.ClassDeclaration);
    const clsName = cls?.getName() ?? parentName ?? '<class>';
    return `${clsName}.${node.getName()}`;
  }
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    // Look for: const name = () => {} or name: () => {}
    const parent = node.getParent();
    if (Node.isVariableDeclaration(parent)) return parent.getName();
    if (Node.isPropertyDeclaration(parent)) {
      const cls = parent.getParentIfKind(SyntaxKind.ClassDeclaration);
      if (cls) return `${cls.getName() ?? parentName ?? '<class>'}.${parent.getName()}`;
      return parent.getName();
    }
    if (Node.isPropertyAssignment(parent)) return parent.getName();
  }
  return null;
}

/** Extract all called symbol names from a function-like node */
function extractCalls(node: FnLike): string[] {
  const calls = new Set<string>();
  for (const call of node.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    const text = expr.getText();
    // Simple call: foo()
    if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(text)) {
      calls.add(text);
    }
    // Method call: this.foo() or obj.foo() — capture the method name
    if (Node.isPropertyAccessExpression(expr)) {
      const methodName = expr.getName();
      const objText = expr.getExpression().getText();
      if (objText === 'this') {
        // Record as ClassName.methodName if we can find the class
        const cls = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
        if (cls?.getName()) {
          calls.add(`${cls.getName()}.${methodName}`);
        } else {
          calls.add(methodName);
        }
      } else {
        calls.add(methodName);
      }
    }
  }
  return [...calls];
}

export function buildGraph(rootDir: string): GraphData {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true },
  });

  walkFiles(rootDir, ['.ts', '.tsx', '.js', '.jsx']).forEach(f =>
    project.addSourceFileAtPath(f)
  );

  const graph: GraphData = {
    symbols: Object.create(null) as Record<string, string[]>,
    callers: Object.create(null) as Record<string, string[]>,
    files: Object.create(null) as Record<string, string[]>,
    symbolFile: Object.create(null) as Record<string, string>,
  };

  for (const sf of project.getSourceFiles()) {
    const relPath = path.relative(rootDir, sf.getFilePath());

    graph.files[relPath] = sf
      .getImportDeclarations()
      .map(d => d.getModuleSpecifierValue());

    // Collect all function-like nodes: declarations, arrow fns, methods
    const fnNodes: FnLike[] = [
      ...sf.getFunctions(),
      ...sf.getDescendantsOfKind(SyntaxKind.ArrowFunction),
      ...sf.getDescendantsOfKind(SyntaxKind.FunctionExpression),
      ...sf.getClasses().flatMap(cls => cls.getMethods()),
    ];

    for (const fn of fnNodes) {
      const name = getFnName(fn as FnLike);
      if (!name) continue;

      const calls = extractCalls(fn as FnLike);
      graph.symbols[name] = [...new Set([...(graph.symbols[name] ?? []), ...calls])];
      graph.symbolFile[name] = relPath;

      // Build inbound (callers) index
      for (const callee of calls) {
        (graph.callers[callee] ??= []);
        if (!graph.callers[callee].includes(name)) {
          graph.callers[callee].push(name);
        }
      }
    }
  }

  // PHP: add symbols, callers, files, symbolFile from PHP sources
  buildPhpGraph(rootDir, graph);

  return graph;
}

export function saveGraph(graph: GraphData, outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(graph, null, 2));
}

export function loadGraph(graphPath: string): GraphData | null {
  if (!fs.existsSync(graphPath)) return null;
  return JSON.parse(fs.readFileSync(graphPath, 'utf-8')) as GraphData;
}
