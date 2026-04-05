import { Project, SyntaxKind, Node, FunctionDeclaration, ArrowFunction, FunctionExpression, MethodDeclaration } from 'ts-morph';
import * as path from 'path';
import { createRequire } from 'module';
import type { GitFilePatch } from './git.js';

type TsFnLike = FunctionDeclaration | ArrowFunction | FunctionExpression | MethodDeclaration;
type SymbolKind = 'function' | 'class' | 'method';

interface LineRange {
    startLine: number;
    endLine: number;
}

interface SymbolRange {
    symbol: string;
    type: SymbolKind;
    startLine: number;
    endLine: number;
}

interface PhpLoc {
    start: { line: number };
    end: { line: number };
}

interface PhpNode {
    kind: string;
    loc?: PhpLoc;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
}

interface PhpEngine {
    parseCode(code: string, filename: string): PhpNode;
}

export interface SemanticTouch {
    symbols: string[];
    hints: string[];
}

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const phpParserPkg = require('php-parser') as any;
const PhpParserEngine: new (opts: unknown) => PhpEngine =
    phpParserPkg.Engine ?? phpParserPkg.default?.Engine ?? phpParserPkg;

const TS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);
const PHP_EXTS = new Set(['.php']);
const tsProject = new Project({
    skipAddingFilesFromTsConfig: true,
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true },
});

function makePhpParser(): PhpEngine {
    return new PhpParserEngine({
        parser: { extractDoc: false, suppressErrors: true },
        ast: { withPositions: true },
        lexer: { all_tokens: false },
    });
}

function phpNodeName(node: PhpNode | string | null | undefined): string | null {
    if (!node) return null;
    if (typeof node === 'string') return node;
    if (node.kind === 'identifier' || node.kind === 'name') return node.name as string;
    return null;
}

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

function intersects(a: LineRange, b: LineRange): boolean {
    return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

function uniqueStrings(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))];
}

function pruneParentSymbols(symbols: SymbolRange[]): string[] {
    const names = new Set(symbols.map(symbol => symbol.symbol));
    return symbols
        .filter(symbol => {
            if (symbol.type !== 'class') return true;
            const dotPrefix = `${symbol.symbol}.`;
            const phpPrefix = `${symbol.symbol}::`;
            return ![...names].some(name => name.startsWith(dotPrefix) || name.startsWith(phpPrefix));
        })
        .sort((left, right) => left.startLine - right.startLine)
        .map(symbol => symbol.symbol);
}

function extractHintsFromPatch(filePatch: GitFilePatch): string[] {
    const hints = uniqueStrings(filePatch.hunks.map(hunk => hunk.header.trim()));
    return hints.filter(hint => hint.length >= 3);
}

function getPatchRanges(filePatch: GitFilePatch, side: 'old' | 'new'): LineRange[] {
    return filePatch.hunks
        .map(hunk => {
            const startLine = side === 'old' ? hunk.oldStart : hunk.newStart;
            const count = side === 'old' ? hunk.oldCount : hunk.newCount;
            return {
                startLine,
                endLine: startLine + Math.max(count, 1) - 1,
            } satisfies LineRange;
        })
        .filter(range => range.startLine > 0);
}

function collectTsSymbolRanges(filePath: string, source: string): SymbolRange[] {
    const sourceFile = tsProject.createSourceFile(filePath, source, { overwrite: true });
    const symbols: SymbolRange[] = [];

    for (const fn of sourceFile.getFunctions()) {
        const name = fn.getName();
        if (!name) continue;
        symbols.push({
            symbol: name,
            type: 'function',
            startLine: fn.getStartLineNumber(),
            endLine: fn.getEndLineNumber(),
        });
    }

    for (const cls of sourceFile.getClasses()) {
        const className = cls.getName();
        if (!className) continue;

        symbols.push({
            symbol: className,
            type: 'class',
            startLine: cls.getStartLineNumber(),
            endLine: cls.getEndLineNumber(),
        });

        for (const method of cls.getMethods()) {
            symbols.push({
                symbol: `${className}.${method.getName()}`,
                type: 'method',
                startLine: method.getStartLineNumber(),
                endLine: method.getEndLineNumber(),
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
        if (symbols.some(symbol => symbol.symbol === name && symbol.startLine === fn.getStartLineNumber())) {
            continue;
        }
        symbols.push({
            symbol: name,
            type: name.includes('.') ? 'method' : 'function',
            startLine: fn.getStartLineNumber(),
            endLine: fn.getEndLineNumber(),
        });
    }

    tsProject.removeSourceFile(sourceFile);
    return symbols;
}

function collectPhpSymbolRanges(filePath: string, source: string): SymbolRange[] {
    const parser = makePhpParser();
    const ast = parser.parseCode(source, filePath);
    const topLevel: PhpNode[] = ast.kind === 'program' ? (ast.children ?? []) : [];
    const containers: Array<{ children: PhpNode[]; nsPrefix: string }> = [];

    for (const node of topLevel) {
        if (node.kind === 'namespace') {
            const nsName = phpNodeName(node.name) ?? '';
            containers.push({ children: node.children ?? [], nsPrefix: nsName ? `${nsName}\\` : '' });
        } else {
            if (containers.length === 0 || containers[0].nsPrefix !== '') {
                containers.unshift({ children: [], nsPrefix: '' });
            }
            containers[0].children.push(node);
        }
    }

    const symbols: SymbolRange[] = [];
    for (const { children, nsPrefix } of containers) {
        for (const node of children) {
            if (node.kind === 'function') {
                const name = phpNodeName(node.name);
                if (!name || !node.loc) continue;
                symbols.push({
                    symbol: `${nsPrefix}${name}`,
                    type: 'function',
                    startLine: node.loc.start.line,
                    endLine: node.loc.end.line,
                });
            }

            if (node.kind !== 'class' && node.kind !== 'interface' && node.kind !== 'trait') continue;
            const className = phpNodeName(node.name);
            if (!className || !node.loc) continue;
            const qualifiedClass = `${nsPrefix}${className}`;
            symbols.push({
                symbol: qualifiedClass,
                type: 'class',
                startLine: node.loc.start.line,
                endLine: node.loc.end.line,
            });

            for (const member of node.body ?? []) {
                if (member.kind !== 'method' || !member.loc) continue;
                const methodName = phpNodeName(member.name);
                if (!methodName) continue;
                symbols.push({
                    symbol: `${qualifiedClass}::${methodName}`,
                    type: 'method',
                    startLine: member.loc.start.line,
                    endLine: member.loc.end.line,
                });
            }
        }
    }

    return symbols;
}

function collectSymbolRanges(filePath: string, source: string): SymbolRange[] {
    const ext = path.extname(filePath).toLowerCase();

    try {
        if (TS_EXTS.has(ext)) return collectTsSymbolRanges(filePath, source);
        if (PHP_EXTS.has(ext)) return collectPhpSymbolRanges(filePath, source);
    } catch {
        return [];
    }

    return [];
}

export function prefersOldRevision(filePatch: GitFilePatch): boolean {
    if (filePatch.status === 'D') return true;
    if (filePatch.hunks.length === 0) return false;
    return filePatch.hunks.every(hunk => hunk.newCount === 0 && hunk.oldCount > 0);
}

export function extractSemanticTouch(
    filePatch: GitFilePatch,
    source: string | null,
    side: 'old' | 'new'
): SemanticTouch {
    const hints = extractHintsFromPatch(filePatch);
    if (!source) {
        return { symbols: [], hints };
    }

    const ranges = getPatchRanges(filePatch, side);
    if (ranges.length === 0) {
        return { symbols: [], hints };
    }

    const symbols = collectSymbolRanges(filePatch.path, source)
        .filter(symbol => ranges.some(range => intersects(range, symbol)))
        .filter(symbol => symbol.symbol !== '<anonymous>');

    return {
        symbols: pruneParentSymbols(symbols),
        hints,
    };
}
