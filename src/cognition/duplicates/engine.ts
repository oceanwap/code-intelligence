import * as path from 'path';
import * as crypto from 'crypto';
import { Project, SyntaxKind, type Node as MorphNode } from 'ts-morph';
import { walkFiles } from '../../indexer.js';
import { moduleFromFile } from '../../utils/module-path.js';
import {
  type DuplicateLocation,
  type DuplicateSeverity,
  type SemanticDuplicateOptions,
  type SemanticDuplicatePattern,
} from './types.js';

interface FunctionShape {
  id: string;
  file: string;
  module: string;
  symbol: string;
  line: number;
  column: number;
  bodyText: string;
  normalized: string;
  hash: string;
  tokens: number;
  kind: 'function' | 'method' | 'arrow' | 'constructor';
}

const RESERVED_WORDS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import',
  'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try',
  'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'await', 'of', 'as', 'from',
  'interface', 'type', 'namespace', 'module', 'declare', 'abstract', 'implements', 'private',
  'protected', 'public', 'readonly', 'get', 'set', 'async', 'constructor',
]);

function isLiteralNode(node: MorphNode): boolean {
  switch (node.getKind()) {
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.TrueKeyword:
    case SyntaxKind.FalseKeyword:
    case SyntaxKind.NullKeyword:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.BigIntLiteral:
    case SyntaxKind.RegularExpressionLiteral:
      return true;
    default:
      return false;
  }
}

function isIdentifierToNormalize(node: MorphNode): boolean {
  if (!node.isKind(SyntaxKind.Identifier)) return false;
  const text = node.getText();
  // Keep reserved words and common global types so structural flow stays readable.
  if (RESERVED_WORDS.has(text)) return false;
  return true;
}

/**
 * Strip comments from a snippet of code using a conservative regex.
 * Single-line comments and block comments are removed.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\r\n]*/g, ' ');
}

export function normalizeBodyText(bodyNode: MorphNode): { normalized: string; tokens: number } {
  const sourceFile = bodyNode.getSourceFile();
  const fullText = sourceFile.getFullText();
  const ranges: Array<{ start: number; end: number; replacement: string }> = [];

  bodyNode.forEachDescendant((child) => {
    if (isLiteralNode(child)) {
      ranges.push({ start: child.getStart(), end: child.getEnd(), replacement: '$LIT$' });
      return false;
    }
    if (isIdentifierToNormalize(child)) {
      ranges.push({ start: child.getStart(), end: child.getEnd(), replacement: '$ID$' });
      return false;
    }
    return false;
  });

  ranges.sort((a, b) => a.start - b.start);

  let cursor = bodyNode.getStart();
  let normalized = '';
  for (const range of ranges) {
    normalized += fullText.slice(cursor, range.start);
    normalized += range.replacement;
    cursor = range.end;
  }
  normalized += fullText.slice(cursor, bodyNode.getEnd());
  normalized = stripComments(normalized);
  normalized = normalized.replace(/\s+/g, ' ').trim();

  // Token count is a rough proxy for complexity: count non-placeholder tokens.
  const tokens = normalized.split(/\s+/).filter(t => t.length > 0).length;
  return { normalized, tokens };
}

function shapeId(file: string, symbol: string, line: number): string {
  return crypto.createHash('sha256').update(`${file}::${symbol}::${line}`).digest('hex').slice(0, 16);
}

export function hashNormalized(normalized: string): string {
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function severityForGroup(size: number, tokens: number): DuplicateSeverity {
  if (size >= 5) return 'high';
  if (size >= 3 || tokens >= 40) return 'medium';
  return 'low';
}

function collectFunctions(project: Project, rootDir: string, options: SemanticDuplicateOptions): FunctionShape[] {
  const shapes: FunctionShape[] = [];
  const minTokens = options.minBodyTokens ?? 8;
  const maxTokens = options.maxBodyTokens ?? 400;

  for (const sf of project.getSourceFiles()) {
    const relPath = path.relative(rootDir, sf.getFilePath()).replace(/\\/g, '/');
    const module = moduleFromFile(relPath);

    for (const fn of sf.getFunctions()) {
      const body = fn.getBody();
      if (!body) continue;
      const name = fn.getName() ?? '<anonymous>';
      const { normalized, tokens } = normalizeBodyText(body);
      if (tokens < minTokens || tokens > maxTokens) continue;
      const pos = sf.getLineAndColumnAtPos(body.getStart());
      shapes.push({
        id: shapeId(relPath, name, pos.line),
        file: relPath,
        module,
        symbol: name,
        line: pos.line,
        column: pos.column,
        bodyText: body.getText().slice(0, 200),
        normalized,
        hash: hashNormalized(normalized),
        tokens,
        kind: 'function',
      });
    }

    for (const cls of sf.getClasses()) {
      const className = cls.getName() ?? '<anonymous>';
      for (const method of cls.getMethods()) {
        const body = method.getBody();
        if (!body) continue;
        const name = method.getName();
        const { normalized, tokens } = normalizeBodyText(body);
        if (tokens < minTokens || tokens > maxTokens) continue;
        const pos = sf.getLineAndColumnAtPos(body.getStart());
        const symbol = `${className}.${name}`;
        const kind = name === 'constructor' ? 'constructor' : 'method';
        shapes.push({
          id: shapeId(relPath, symbol, pos.line),
          file: relPath,
          module,
          symbol,
          line: pos.line,
          column: pos.column,
          bodyText: body.getText().slice(0, 200),
          normalized,
          hash: hashNormalized(normalized),
          tokens,
          kind,
        });
      }
    }

    for (const arrow of sf.getDescendants().filter(n => n.isKind(SyntaxKind.ArrowFunction))) {
      const body = arrow.getBody();
      if (!body) continue;
      // Skip very short expression-bodied arrows; they are usually trivial.
      if (body.getKind() !== SyntaxKind.Block && body.getText().length < 20) continue;
      const parent = arrow.getParent();
      let symbol = '<anonymous-arrow>';
      if (parent?.isKind(SyntaxKind.VariableDeclaration)) {
        symbol = (parent as { getName?(): string }).getName?.() ?? symbol;
      }
      const { normalized, tokens } = normalizeBodyText(body);
      if (tokens < minTokens || tokens > maxTokens) continue;
      const pos = sf.getLineAndColumnAtPos(body.getStart());
      shapes.push({
        id: shapeId(relPath, symbol, pos.line),
        file: relPath,
        module,
        symbol,
        line: pos.line,
        column: pos.column,
        bodyText: body.getText().slice(0, 200),
        normalized,
        hash: hashNormalized(normalized),
        tokens,
        kind: 'arrow',
      });
    }
  }

  return shapes;
}

function groupByHash(shapes: FunctionShape[]): Map<string, FunctionShape[]> {
  const groups = new Map<string, FunctionShape[]>();
  for (const shape of shapes) {
    const existing = groups.get(shape.hash) ?? [];
    existing.push(shape);
    groups.set(shape.hash, existing);
  }
  return groups;
}

function locationFromShape(shape: FunctionShape): DuplicateLocation {
  return {
    file: shape.file,
    line: shape.line,
    column: shape.column,
    symbol: shape.symbol,
    module: shape.module,
  };
}

function patternFromGroup(group: FunctionShape[], index: number): SemanticDuplicatePattern {
  const representative = group[0]!;
  const locations = group.map(locationFromShape);
  const size = group.length;
  const avgTokens = Math.round(group.reduce((sum, s) => sum + s.tokens, 0) / size);
  const modules = [...new Set(locations.map(l => l.module))];
  return {
    id: `ts-morph:structural:${representative.hash}:${index}`,
    category: 'structural-duplicate',
    title: `Semantic duplicate ${representative.kind === 'method' ? 'method' : 'function'} shape (${size} occurrences)`,
    description:
      `${size} functions/methods share a structurally identical body after normalizing identifiers and literals. ` +
      `Average normalized token count: ${avgTokens}. ` +
      `Consider extracting a shared helper or abstraction. ` +
      `Normalized shape preview: ${representative.normalized.slice(0, 120)}...`,
    severity: severityForGroup(size, avgTokens),
    source: 'ts-morph',
    locations,
    meta: {
      normalizedPreview: representative.normalized.slice(0, 200),
      averageTokens: avgTokens,
      occurrenceCount: size,
      affectedModules: modules,
      kinds: [...new Set(group.map(g => g.kind))],
    },
  };
}

function matchesGlobs(relPath: string, globs: string[] | undefined): boolean {
  if (!globs || globs.length === 0) return false;
  const normalized = relPath.replace(/\\/g, '/');
  for (const glob of globs) {
    const pattern = glob
      .replace(/\*\*/g, '<<DBLSTAR>>')
      .replace(/\*/g, '[^/]*')
      .replace(/<<DBLSTAR>>/g, '.*');
    const regex = new RegExp(`^${pattern}$`);
    if (regex.test(normalized)) return true;
  }
  return false;
}

function shouldScanFile(relPath: string, options: SemanticDuplicateOptions): boolean {
  const normalized = relPath.replace(/\\/g, '/').toLowerCase();
  if (!options.includeTests) {
    if (
      normalized.startsWith('test/')
      || normalized.startsWith('tests/')
      || normalized.includes('/__tests__/')
      || /\.(test|spec)\.[a-z0-9]+$/.test(normalized)
    ) {
      return false;
    }
  }
  if (options.excludeGlobs && matchesGlobs(relPath, options.excludeGlobs)) return false;
  if (options.includeGlobs && options.includeGlobs.length > 0 && !matchesGlobs(relPath, options.includeGlobs)) return false;
  return true;
}

export async function detectStructuralDuplicatesAsync(
  projectRoot: string,
  options: SemanticDuplicateOptions = {}
): Promise<SemanticDuplicatePattern[]> {
  const root = path.resolve(projectRoot);
  const files = await walkFiles(root, ['.ts', '.tsx', '.js', '.jsx']);
  const filtered = files
    .map(f => path.relative(root, f).replace(/\\/g, '/'))
    .filter(rel => shouldScanFile(rel, options))
    .map(rel => path.join(root, rel));

  if (filtered.length === 0) return [];

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { allowJs: true },
  });
  for (const file of filtered) {
    project.addSourceFileAtPath(file);
  }

  const shapes = collectFunctions(project, root, options);
  const groups = groupByHash(shapes);
  const minOccurrences = options.minOccurrences ?? 2;

  const patterns: SemanticDuplicatePattern[] = [];
  let index = 0;
  for (const group of groups.values()) {
    if (group.length >= minOccurrences) {
      patterns.push(patternFromGroup(group, index));
      index += 1;
    }
  }

  return patterns.sort((a, b) => {
    const sevOrder = { high: 0, medium: 1, low: 2 };
    if (sevOrder[a.severity] !== sevOrder[b.severity]) {
      return sevOrder[a.severity] - sevOrder[b.severity];
    }
    return b.locations.length - a.locations.length;
  });
}
