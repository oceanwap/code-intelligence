import assert from 'node:assert/strict';
import test from 'node:test';
import { renderCompactCallGraphLines } from '../src/call-graph-preview.js';

test('renderCompactCallGraphLines renders a chain/tree style graph', () => {
  const lines = renderCompactCallGraphLines([
    {
      symbol: 'A.checkoutCart',
      connectionsWithinResults: { calls: ['B.billCart'] },
    },
    {
      symbol: 'B.billCart',
      connectionsWithinResults: { calls: ['C.createBill'] },
    },
    {
      symbol: 'C.createBill',
      connectionsWithinResults: { calls: ['D.createPositions', 'E.getCreatorId'] },
    },
    { symbol: 'D.createPositions' },
    { symbol: 'E.getCreatorId' },
  ], { linePrefix: '  ' });

  assert.equal(lines[0], 'Small call graph:');
  const payload = lines.slice(1).join('\n');
  assert.ok(payload.includes('A.checkoutCart'));
  assert.ok(payload.includes('B.billCart'));
  assert.ok(payload.includes('C.createBill'));
  assert.ok(payload.includes('D.createPositions'));
  assert.ok(payload.includes('E.getCreatorId'));
  assert.ok(payload.includes('├') || payload.includes('└'));
});
