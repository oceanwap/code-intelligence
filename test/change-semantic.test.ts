import assert from 'node:assert/strict';
import test from 'node:test';
import { extractSemanticTouch } from '../src/change-semantic.js';
import type { GitFilePatch } from '../src/git.js';

test('extractSemanticTouch maps method hunks to the method symbol, not the parent class', () => {
    const source = [
        'class AuthService {',
        '  login() {',
        '    validate();',
        '    return true;',
        '  }',
        '',
        '  logout() {',
        '    return false;',
        '  }',
        '}',
        '',
        'function validate() {',
        '  return true;',
        '}',
    ].join('\n');

    const patch: GitFilePatch = {
        path: 'src/auth.ts',
        status: 'M',
        hunks: [
            {
                oldStart: 2,
                oldCount: 4,
                newStart: 2,
                newCount: 4,
                header: 'login flow',
            },
        ],
    };

    const touch = extractSemanticTouch(patch, source, 'new');

    assert.deepEqual(touch.symbols, ['AuthService.login']);
    assert.deepEqual(touch.hints, ['login flow']);
});

test('extractSemanticTouch maps standalone function hunks to the function symbol', () => {
    const source = [
        'class AuthService {',
        '  login() {',
        '    validate();',
        '    return true;',
        '  }',
        '}',
        '',
        'function validate() {',
        '  return true;',
        '}',
    ].join('\n');

    const patch: GitFilePatch = {
        path: 'src/auth.ts',
        status: 'M',
        hunks: [
            {
                oldStart: 8,
                oldCount: 3,
                newStart: 8,
                newCount: 3,
                header: 'validate helper',
            },
        ],
    };

    const touch = extractSemanticTouch(patch, source, 'new');

    assert.deepEqual(touch.symbols, ['validate']);
    assert.deepEqual(touch.hints, ['validate helper']);
});