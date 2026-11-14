import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcile} from '../depth_capture.mjs';

test('depth intervals accept overlap, ignore duplicates and flag missing sequence IDs', () => {
  assert.equal(reconcile(100,99,100),'old');
  assert.equal(reconcile(100,99,101),'apply');
  assert.equal(reconcile(100,101,102),'apply');
  assert.equal(reconcile(100,102,104),'gap');
});
