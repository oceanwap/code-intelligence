import { Project, SyntaxKind, Node, FunctionDeclaration, ArrowFunction, FunctionExpression, MethodDeclaration } from 'ts-morph';
import * as path from 'path';

type TsFnLike = FunctionDeclaration | ArrowFunction | FunctionExpression | MethodDeclaration;
type SymbolVisibility = 'public' | 'protected' | 'private' | 'none';

export interface SymbolSignatureDetails {
  params: string[];
  returnType: string;
  visibility: SymbolVisibility;
  isAsync: boolean;
  isStatic: boolean;
}

export interface SymbolSignatureDelta {
  paramsAdded: string[];
  paramsRemoved: string[];
  returnTypeChanged: boolean;
  visibilityChanged: boolean;
  asyncChanged: boolean;
  staticChanged: boolean;
}

export interface SymbolSnapshot {
  symbol: string;
  signature: string;
  bodyFingerprint: string;
  details?: SymbolSignatureDetails;
}

const TS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const tsProject = new Project({
  skipAddingFilesFromTsConfig: true,
  useInMemoryFileSystem: true,
  compilerOptions: { allowJs: true },
});

function getTsFnName(node: TsFnLike, parentName?: string): string | null {
  if (Node.isFunctionDeclaration(node)) return node.getName() ?? null;
  if (Node.isMethodDeclaration(node)) {
    const cls = node.getParentIfKind(SyntaxKind.ClassDeclaration);
    const clsName = cls?.getName() ?? parentName ?? '<class>';
    return `${clsName}.${node.getName()}`;
  }
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
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

function normalizeFingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/['"`][^'"`]*['"`]/g, 'str')
    .replace(/\b\d+(?:\.\d+)?\b/g, 'num')
    .replace(/[^a-z0-9_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function jaccardTokens(left: string, right: string): number {
  const leftSet = new Set(left.split(' ').filter(Boolean));
  const rightSet = new Set(right.split(' ').filter(Boolean));
  if (leftSet.size === 0 && rightSet.size === 0) return 1;
  if (leftSet.size === 0 || rightSet.size === 0) return 0;

  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) intersection += 1;
  }
  const union = new Set([...leftSet, ...rightSet]).size;
  return union === 0 ? 0 : intersection / union;
}

function parameterSignature(node: TsFnLike): string {
  const params = node.getParameters().map(parameter => {
    const name = parameter.getName();
    const question = parameter.isOptional() ? '?' : '';
    const rest = parameter.isRestParameter() ? '...' : '';
    const type = parameter.getTypeNode()?.getText() ?? 'any';
    return `${rest}${name}${question}:${type}`;
  });
  return `(${params.join(',')})`;
}

function parameterDetails(node: TsFnLike): string[] {
  return node.getParameters().map(parameter => {
    const name = parameter.getName();
    const question = parameter.isOptional() ? '?' : '';
    const rest = parameter.isRestParameter() ? '...' : '';
    const type = parameter.getTypeNode()?.getText() ?? 'any';
    return `${rest}${name}${question}:${type}`;
  });
}

function methodVisibility(method: MethodDeclaration): SymbolVisibility {
  if (method.hasModifier(SyntaxKind.PrivateKeyword)) return 'private';
  if (method.hasModifier(SyntaxKind.ProtectedKeyword)) return 'protected';
  if (method.hasModifier(SyntaxKind.PublicKeyword)) return 'public';
  return 'none';
}

function methodModifiers(method: MethodDeclaration): string {
  const mods: string[] = [];
  if (method.isStatic()) mods.push('static');
  if (method.isAsync()) mods.push('async');
  if (method.hasModifier(SyntaxKind.ProtectedKeyword)) mods.push('protected');
  if (method.hasModifier(SyntaxKind.PrivateKeyword)) mods.push('private');
  if (method.hasModifier(SyntaxKind.PublicKeyword)) mods.push('public');
  return mods.join(' ');
}

function classSignature(className: string, cls: import('ts-morph').ClassDeclaration): string {
  const extendsType = cls.getExtends()?.getExpression().getText() ?? '';
  const impl = cls.getImplements().map(item => item.getExpression().getText()).join(',');
  const members = cls.getMethods().map(method => `${method.getName()}${parameterSignature(method)}`).join('|');
  return `class ${className} extends:${extendsType} implements:${impl} members:${members}`;
}

function extractTsSnapshots(filePath: string, source: string): SymbolSnapshot[] {
  const sourceFile = tsProject.createSourceFile(filePath, source, { overwrite: true });
  const snapshots: SymbolSnapshot[] = [];

  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName();
    if (!name) continue;
    const returnType = fn.getReturnTypeNode()?.getText() ?? 'any';
    const signature = `function ${name}${parameterSignature(fn)}:${returnType}`;
    const body = fn.getBodyText() ?? '';
    snapshots.push({
      symbol: name,
      signature,
      bodyFingerprint: normalizeFingerprint(body),
      details: {
        params: parameterDetails(fn),
        returnType,
        visibility: 'none',
        isAsync: fn.isAsync(),
        isStatic: false,
      },
    });
  }

  for (const cls of sourceFile.getClasses()) {
    const className = cls.getName();
    if (!className) continue;
    snapshots.push({
      symbol: className,
      signature: classSignature(className, cls),
      bodyFingerprint: normalizeFingerprint(cls.getText()),
    });

    for (const method of cls.getMethods()) {
      const symbol = `${className}.${method.getName()}`;
      const returnType = method.getReturnTypeNode()?.getText() ?? 'any';
      const signature = `method ${methodModifiers(method)} ${symbol}${parameterSignature(method)}:${returnType}`;
      const body = method.getBodyText() ?? '';
      snapshots.push({
        symbol,
        signature,
        bodyFingerprint: normalizeFingerprint(body),
        details: {
          params: parameterDetails(method),
          returnType,
          visibility: methodVisibility(method),
          isAsync: method.isAsync(),
          isStatic: method.isStatic(),
        },
      });
    }
  }

  const extraFunctions: TsFnLike[] = [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionExpression),
  ];

  for (const fn of extraFunctions) {
    const name = getTsFnName(fn);
    if (!name) continue;
    if (snapshots.some(item => item.symbol === name)) continue;
    const returnType = fn.getReturnTypeNode()?.getText() ?? 'any';
    const signature = `fn ${name}${parameterSignature(fn)}:${returnType}`;
    const body = fn.getBodyText() ?? '';
    snapshots.push({
      symbol: name,
      signature,
      bodyFingerprint: normalizeFingerprint(body),
      details: {
        params: parameterDetails(fn),
        returnType,
        visibility: 'none',
        isAsync: fn.isAsync(),
        isStatic: false,
      },
    });
  }

  tsProject.removeSourceFile(sourceFile);
  return snapshots;
}

export function extractSymbolSnapshots(filePath: string, source: string | null): Map<string, SymbolSnapshot> {
  const map = new Map<string, SymbolSnapshot>();
  if (!source) return map;
  const ext = path.extname(filePath).toLowerCase();
  if (!TS_EXTS.has(ext)) return map;

  try {
    const snapshots = extractTsSnapshots(filePath, source);
    for (const snapshot of snapshots) {
      map.set(snapshot.symbol, snapshot);
    }
  } catch {
    return map;
  }

  return map;
}

export function bodySimilarity(left: SymbolSnapshot | undefined, right: SymbolSnapshot | undefined): number {
  if (!left || !right) return 0;
  return jaccardTokens(left.bodyFingerprint, right.bodyFingerprint);
}

export function computeSignatureDelta(
  before: SymbolSnapshot | undefined,
  after: SymbolSnapshot | undefined
): SymbolSignatureDelta | undefined {
  if (!before?.details || !after?.details) return undefined;
  const beforeParams = new Set(before.details.params);
  const afterParams = new Set(after.details.params);

  const paramsAdded = after.details.params.filter(param => !beforeParams.has(param));
  const paramsRemoved = before.details.params.filter(param => !afterParams.has(param));

  return {
    paramsAdded,
    paramsRemoved,
    returnTypeChanged: before.details.returnType !== after.details.returnType,
    visibilityChanged: before.details.visibility !== after.details.visibility,
    asyncChanged: before.details.isAsync !== after.details.isAsync,
    staticChanged: before.details.isStatic !== after.details.isStatic,
  };
}
