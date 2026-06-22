import { Project, SyntaxKind, Node, FunctionDeclaration, ArrowFunction, FunctionExpression, MethodDeclaration } from 'ts-morph';
import * as path from 'path';
import { mkdir } from 'node:fs/promises';
import { walkFiles } from './indexer.js';
import { buildPhpGraphAsync } from './php-graph.js';
import type { IndexingMode } from './indexer.js';
import { loadWorkspaceResolverAsync, resolveImportToFile } from './workspace-imports.js';

export interface GraphCallSite {
  symbol: string;
  file: string;
  line: number;
}

export interface GraphData {
  /** symbol name → list of called symbol names (outbound) */
  symbols: Record<string, string[]>;
  /** caller symbol → compact callsite entries for outbound calls */
  callSites?: Record<string, GraphCallSite[]>;
  /** symbol name → list of symbol names that call it (inbound/callers) */
  callers: Record<string, string[]>;
  /** callee symbol → compact callsite entries for inbound callers */
  calledBySites?: Record<string, GraphCallSite[]>;
  /** relative file path → list of import specifiers */
  files: Record<string, string[]>;
  /** symbol name → relative file path it lives in */
  symbolFile: Record<string, string>;
  /** type/interface symbol name → direct supertypes it extends or implements */
  supertypes: Record<string, string[]>;
  /** type/interface symbol name → direct known subtypes or implementers */
  subtypes: Record<string, string[]>;
  /** symbol name → concrete symbols that implement or override it */
  implementations: Record<string, string[]>;
  /** symbol name → base symbols it implements or overrides */
  implementedFrom: Record<string, string[]>;
  /** symbol name → related entity symbols discovered via TypeORM decorators (optional, also mirrored into symbols/callers) */
  entityRelations?: Record<string, string[]>;
  /** relative file path → list of resolved imported file paths (relative to projectRoot) */
  resolvedImports: Record<string, string[]>;
}

type FnLike = FunctionDeclaration | ArrowFunction | FunctionExpression | MethodDeclaration;

type TypeMembers = Record<string, Set<string>>;

function addUnique(target: Record<string, string[]>, key: string, value: string): void {
  if (!key || !value) return;
  const entries = (target[key] ??= []);
  if (!entries.includes(value)) entries.push(value);
}

function addCallSite(target: Record<string, GraphCallSite[]>, key: string, value: GraphCallSite): void {
  if (!key || !value.symbol || !value.file || value.line < 1) return;
  const entries = (target[key] ??= []);
  if (!entries.some(entry => entry.symbol === value.symbol && entry.file === value.file && entry.line === value.line)) {
    entries.push(value);
  }
}

async function buildResolvedImportsAsync(graph: GraphData, rootDir: string): Promise<void> {
  const resolver = await loadWorkspaceResolverAsync(rootDir);
  for (const [filePath, specifiers] of Object.entries(graph.files)) {
    const resolved: string[] = [];
    for (const spec of specifiers) {
      const target = await resolveImportToFile(filePath, spec, resolver);
      if (target && target !== filePath) resolved.push(target);
    }
    if (resolved.length > 0) graph.resolvedImports[filePath] = resolved;
  }
}

function isTypeOrmEntity(cls: import('ts-morph').ClassDeclaration): boolean {
  return cls.getDecorators().some(decorator => decorator.getName() === 'Entity');
}

function extractTypeOrmRelationTargets(cls: import('ts-morph').ClassDeclaration): string[] {
  const targets = new Set<string>();
  const RELATION_DECORATORS = new Set([
    'ManyToOne', 'OneToMany', 'ManyToMany', 'OneToOne',
    'JoinColumn', 'JoinTable',
  ]);

  for (const property of cls.getInstanceProperties()) {
    for (const decorator of property.getDecorators()) {
      const name = decorator.getName();
      if (!RELATION_DECORATORS.has(name)) continue;

      const args = decorator.getArguments();
      for (const arg of args) {
        // String form: @ManyToOne('Contact')
        if (arg.getKind() === SyntaxKind.StringLiteral) {
          const text = (arg as import('ts-morph').StringLiteral).getLiteralValue();
          if (text) targets.add(text);
          continue;
        }

        // Arrow function form: @ManyToOne(() => Contact)
        if (arg.getKind() === SyntaxKind.ArrowFunction) {
          const body = (arg as import('ts-morph').ArrowFunction).getBody();
          if (body.getKind() === SyntaxKind.Identifier) {
            targets.add(body.getText());
          }
          continue;
        }

        // Function form: @ManyToOne(function() { return Contact; })
        if (arg.getKind() === SyntaxKind.FunctionExpression) {
          const returns = (arg as import('ts-morph').FunctionExpression).getStatements()
            .filter(stmt => stmt.getKind() === SyntaxKind.ReturnStatement)
            .map(stmt => stmt as import('ts-morph').ReturnStatement);
          for (const ret of returns) {
            const expr = ret.getExpression();
            if (expr && expr.getKind() === SyntaxKind.Identifier) {
              targets.add(expr.getText());
            }
          }
        }
      }
    }
  }

  return [...targets];
}

function normalizeTypeName(name: string | null | undefined): string | null {
  if (!name) return null;
  const normalized = name.trim().replace(/^typeof\s+/, '');
  return normalized || null;
}

function directTypeReferences(values: Array<string | null | undefined>): string[] {
  const refs = new Set<string>();
  for (const value of values) {
    const normalized = normalizeTypeName(value);
    if (normalized) refs.add(normalized);
  }
  return [...refs];
}

function collectAllSupertypes(typeName: string, directSupertypes: Record<string, string[]>, seen = new Set<string>()): string[] {
  for (const supertype of directSupertypes[typeName] ?? []) {
    if (seen.has(supertype)) continue;
    seen.add(supertype);
    collectAllSupertypes(supertype, directSupertypes, seen);
  }
  return [...seen];
}

function registerSupertypes(graph: GraphData, typeName: string, supertypes: string[]): void {
  if (supertypes.length > 0) {
    graph.supertypes[typeName] = supertypes;
  }
  for (const supertype of supertypes) {
    addUnique(graph.subtypes, supertype, typeName);
  }
}

function registerImplementation(graph: GraphData, baseSymbol: string, implementationSymbol: string): void {
  addUnique(graph.implementations, baseSymbol, implementationSymbol);
  addUnique(graph.implementedFrom, implementationSymbol, baseSymbol);
}

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
function extractCalls(node: FnLike, relPath: string): GraphCallSite[] {
  const calls: GraphCallSite[] = [];
  for (const call of node.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    const text = expr.getText();
    const line = call.getStartLineNumber();
    // Simple call: foo()
    if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(text)) {
      calls.push({ symbol: text, file: relPath, line });
    }
    // Method call: this.foo() or obj.foo() — capture the method name
    if (Node.isPropertyAccessExpression(expr)) {
      const methodName = expr.getName();
      const objText = expr.getExpression().getText();
      if (objText === 'this') {
        // Record as ClassName.methodName if we can find the class
        const cls = node.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
        if (cls?.getName()) {
          calls.push({ symbol: `${cls.getName()}.${methodName}`, file: relPath, line });
        } else {
          calls.push({ symbol: methodName, file: relPath, line });
        }
      } else {
        calls.push({ symbol: methodName, file: relPath, line });
      }
    }
  }
  return calls;
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

export async function buildGraph(rootDir: string, options?: { mode?: IndexingMode; includeFiles?: Set<string> }): Promise<GraphData> {
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

  const graph: GraphData = {
    symbols: Object.create(null) as Record<string, string[]>,
    callSites: Object.create(null) as Record<string, GraphCallSite[]>,
    callers: Object.create(null) as Record<string, string[]>,
    calledBySites: Object.create(null) as Record<string, GraphCallSite[]>,
    files: Object.create(null) as Record<string, string[]>,
    symbolFile: Object.create(null) as Record<string, string>,
    supertypes: Object.create(null) as Record<string, string[]>,
    subtypes: Object.create(null) as Record<string, string[]>,
    implementations: Object.create(null) as Record<string, string[]>,
    implementedFrom: Object.create(null) as Record<string, string[]>,
    entityRelations: Object.create(null) as Record<string, string[]>,
    resolvedImports: Object.create(null) as Record<string, string[]>,
  };

  const typeMembers: TypeMembers = Object.create(null) as TypeMembers;
  const typeNames = new Set<string>();

  for (const sf of project.getSourceFiles()) {
    const relPath = path.relative(rootDir, sf.getFilePath());

    graph.files[relPath] = sf
      .getImportDeclarations()
      .map(d => d.getModuleSpecifierValue());

    for (const iface of sf.getInterfaces()) {
      const interfaceName = iface.getName();
      if (!interfaceName) continue;

      graph.symbolFile[interfaceName] = relPath;
      typeNames.add(interfaceName);
      typeMembers[interfaceName] = new Set(iface.getMethods().map(method => method.getName()));
      registerSupertypes(
        graph,
        interfaceName,
        directTypeReferences(iface.getExtends().map(expr => expr.getExpression().getText()))
      );
    }

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

      const calls = extractCalls(fn as FnLike, relPath);
      graph.symbols[name] = [...new Set([...(graph.symbols[name] ?? []), ...calls.map(call => call.symbol)])];
      for (const call of calls) addCallSite(graph.callSites!, name, call);
      graph.symbolFile[name] = relPath;

      // Build inbound (callers) index
      for (const callee of calls) {
        (graph.callers[callee.symbol] ??= []);
        if (!graph.callers[callee.symbol].includes(name)) {
          graph.callers[callee.symbol].push(name);
        }
        addCallSite(graph.calledBySites!, callee.symbol, { symbol: name, file: relPath, line: callee.line });
      }
    }

    for (const cls of sf.getClasses()) {
      const className = cls.getName();
      if (!className) continue;

      typeNames.add(className);

      if (isTypeOrmEntity(cls)) {
        const relationTargets = extractTypeOrmRelationTargets(cls);
        if (relationTargets.length > 0) {
          graph.entityRelations![className] = relationTargets;
          for (const target of relationTargets) {
            addUnique(graph.symbols, className, target);
            addUnique(graph.callers, target, className);
          }
        }
      }

      typeMembers[className] = new Set(cls.getMethods().map(method => method.getName()));
      const directSupertypes = directTypeReferences([
        cls.getExtends()?.getExpression().getText(),
        ...cls.getImplements().map(expr => expr.getExpression().getText()),
      ]);
      registerSupertypes(graph, className, directSupertypes);
    }
  }

  for (const typeName of typeNames) {
    const allSupertypes = collectAllSupertypes(typeName, graph.supertypes);

    for (const supertype of allSupertypes) {
      registerImplementation(graph, supertype, typeName);
    }

    for (const memberName of typeMembers[typeName] ?? []) {
      const implementationSymbol = `${typeName}.${memberName}`;
      for (const supertype of allSupertypes) {
        if (!(typeMembers[supertype]?.has(memberName))) continue;
        registerImplementation(graph, `${supertype}.${memberName}`, implementationSymbol);
      }
    }
  }

  await buildResolvedImportsAsync(graph, rootDir);

  return graph;
}

export async function buildGraphAsync(rootDir: string, options?: { mode?: IndexingMode; includeFiles?: Set<string> }): Promise<GraphData> {
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

  const graph: GraphData = {
    symbols: Object.create(null) as Record<string, string[]>,
    callSites: Object.create(null) as Record<string, GraphCallSite[]>,
    callers: Object.create(null) as Record<string, string[]>,
    calledBySites: Object.create(null) as Record<string, GraphCallSite[]>,
    files: Object.create(null) as Record<string, string[]>,
    symbolFile: Object.create(null) as Record<string, string>,
    supertypes: Object.create(null) as Record<string, string[]>,
    subtypes: Object.create(null) as Record<string, string[]>,
    implementations: Object.create(null) as Record<string, string[]>,
    implementedFrom: Object.create(null) as Record<string, string[]>,
    entityRelations: Object.create(null) as Record<string, string[]>,
    resolvedImports: Object.create(null) as Record<string, string[]>,
  };

  const typeMembers: TypeMembers = Object.create(null) as TypeMembers;
  const typeNames = new Set<string>();

  for (const sf of project.getSourceFiles()) {
    const relPath = path.relative(rootDir, sf.getFilePath());

    graph.files[relPath] = sf
      .getImportDeclarations()
      .map(d => d.getModuleSpecifierValue());

    for (const iface of sf.getInterfaces()) {
      const interfaceName = iface.getName();
      if (!interfaceName) continue;

      graph.symbolFile[interfaceName] = relPath;
      typeNames.add(interfaceName);
      typeMembers[interfaceName] = new Set(iface.getMethods().map(method => method.getName()));
      registerSupertypes(
        graph,
        interfaceName,
        directTypeReferences(iface.getExtends().map(expr => expr.getExpression().getText()))
      );
    }

    const fnNodes: FnLike[] = [
      ...sf.getFunctions(),
      ...sf.getDescendantsOfKind(SyntaxKind.ArrowFunction),
      ...sf.getDescendantsOfKind(SyntaxKind.FunctionExpression),
      ...sf.getClasses().flatMap(cls => cls.getMethods()),
    ];

    for (const fn of fnNodes) {
      const name = getFnName(fn as FnLike);
      if (!name) continue;

      const calls = extractCalls(fn as FnLike, relPath);
      graph.symbols[name] = [...new Set([...(graph.symbols[name] ?? []), ...calls.map(call => call.symbol)])];
      for (const call of calls) addCallSite(graph.callSites!, name, call);
      graph.symbolFile[name] = relPath;

      for (const callee of calls) {
        (graph.callers[callee.symbol] ??= []);
        if (!graph.callers[callee.symbol].includes(name)) {
          graph.callers[callee.symbol].push(name);
        }
        addCallSite(graph.calledBySites!, callee.symbol, { symbol: name, file: relPath, line: callee.line });
      }
    }

    for (const cls of sf.getClasses()) {
      const className = cls.getName();
      if (!className) continue;

      typeNames.add(className);

      if (isTypeOrmEntity(cls)) {
        const relationTargets = extractTypeOrmRelationTargets(cls);
        if (relationTargets.length > 0) {
          graph.entityRelations![className] = relationTargets;
          for (const target of relationTargets) {
            addUnique(graph.symbols, className, target);
            addUnique(graph.callers, target, className);
          }
        }
      }

      typeMembers[className] = new Set(cls.getMethods().map(method => method.getName()));
      const directSupertypes = directTypeReferences([
        cls.getExtends()?.getExpression().getText(),
        ...cls.getImplements().map(expr => expr.getExpression().getText()),
      ]);
      registerSupertypes(graph, className, directSupertypes);
    }
  }

  for (const typeName of typeNames) {
    const allSupertypes = collectAllSupertypes(typeName, graph.supertypes);

    for (const supertype of allSupertypes) {
      registerImplementation(graph, supertype, typeName);
    }

    for (const memberName of typeMembers[typeName] ?? []) {
      const implementationSymbol = `${typeName}.${memberName}`;
      for (const supertype of allSupertypes) {
        if (!(typeMembers[supertype]?.has(memberName))) continue;
        registerImplementation(graph, `${supertype}.${memberName}`, implementationSymbol);
      }
    }
  }

  await buildPhpGraphAsync(rootDir, graph, { includeFiles });

  await buildResolvedImportsAsync(graph, rootDir);

  return graph;
}

export async function saveGraph(graph: GraphData, outPath: string): Promise<void> {
  await mkdir(path.dirname(outPath), { recursive: true });
  await Bun.write(outPath, JSON.stringify(graph, null, 2));
}

export async function loadGraphAsync(graphPath: string): Promise<GraphData | null> {
  try {
    const raw = await Bun.file(graphPath).text();
    return JSON.parse(raw) as GraphData;
  } catch {
    return null;
  }
}

export async function loadGraphAsyncStrict(graphPath: string): Promise<GraphData | null> {
  try {
    const file = Bun.file(graphPath);
    if (!(await file.exists())) return null;
    return JSON.parse(await file.text()) as GraphData;
  } catch {
    return null;
  }
}

