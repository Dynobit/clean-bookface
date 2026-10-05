import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationUpdate } from '../src/verification-view';

test('replayed terminal requests cannot clear a current identity comparison', () => {
  for (const phase of ['done', 'cancelled']) {
    assert.equal(verificationUpdate('current', { id: 'earlier', phase }), 'ignore');
    assert.equal(verificationUpdate('', { id: 'earlier', phase }), 'ignore');
  }
  assert.equal(verificationUpdate('current', { id: 'current', phase: 'started' }), 'show');
});

test('only the selected identity request can finish its dialog', () => {
  assert.equal(verificationUpdate('', { id: 'current', phase: 'requested' }), 'show');
  for (const phase of ['ready', 'started']) {
    assert.equal(verificationUpdate('current', { id: 'current', phase }), 'show');
  }
  for (const phase of ['done', 'cancelled']) {
    assert.equal(verificationUpdate('current', { id: 'current', phase }), 'finish');
  }
});

test('another pending request cannot replace the identity being compared', () => {
  for (const phase of ['requested', 'ready', 'started']) {
    assert.equal(verificationUpdate('current', { id: 'another', phase }), 'busy');
  }
  assert.equal(verificationUpdate('', { id: 'another', phase: 'requested' }), 'show');
});
