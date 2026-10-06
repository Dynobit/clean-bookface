import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSocial, socialState, type SocialAction, type SocialEvent } from '../src/social.js';
const post = { id: 'a'.repeat(64), sender: '@alice:example.org' };
const peer = '@ben:example.org';
function event(id: string, action: SocialAction, sender = peer): SocialEvent {
  return {
    payload: parseSocial({
      version: 1,
      purpose: 'social',
      id: id.repeat(16),
      postId: post.id,
      postSender: post.sender,
      ...action,
    }),
    sender,
    timestamp: 1,
  };
}
test('comments deduplicate retries and removal persists across replay', () => {
  const comment = event('c', { kind: 'comment', text: 'hello' });
  const remove = event('d', { kind: 'remove-comment', commentId: comment.payload.id });
  assert.equal(socialState(post, [comment, comment]).comments.length, 1);
  assert.deepEqual(socialState(post, [comment, remove, comment]).comments, []);
  assert.throws(
    () => socialState(post, [comment, { ...remove, sender: post.sender }]),
    /commenter/,
  );
});
test('post tombstones require owner and survive replay', () => {
  assert.throws(() => socialState(post, [event('d', { kind: 'remove-post' })]), /owner/);
  assert.equal(socialState(post, [event('d', { kind: 'remove-post' }, post.sender)]).removed, true);
});
test('reaction updates and clears resist old-operation replay', () => {
  const first = event('a', { kind: 'reaction', reaction: '♥' });
  const second = event('b', { kind: 'reaction', reaction: '👍' });
  assert.deepEqual(socialState(post, [first, second, first]).reactions, [
    { sender: peer, reaction: '👍' },
  ]);
  assert.deepEqual(
    socialState(post, [first, event('d', { kind: 'reaction', reaction: null }), first]).reactions,
    [],
  );
});
test('conflicting operation identities and cross-post targets fail closed', () => {
  assert.throws(
    () =>
      socialState(post, [
        event('a', { kind: 'comment', text: 'one' }),
        event('a', { kind: 'comment', text: 'two' }),
      ]),
    /Conflicting/,
  );
  assert.throws(
    () => socialState({ ...post, sender: peer }, [event('a', { kind: 'reaction', reaction: '♥' })]),
    /binding/,
  );
  assert.throws(
    () =>
      socialState({ ...post, id: 'b'.repeat(64) }, [
        event('a', { kind: 'reaction', reaction: '♥' }),
      ]),
    /binding/,
  );
});
test('bounded strict schema refuses malformed or excess content', () => {
  const p = event('a', { kind: 'comment', text: 'hello' }).payload;
  for (const value of [
    { ...p, room: 'other' },
    { ...p, text: '' },
    { ...p, text: 'x'.repeat(4001) },
    { ...p, id: '' },
  ])
    assert.throws(() => parseSocial(value));
  assert.throws(() => event('a', { kind: 'reaction', reaction: 'arbitrary' }));
});

test('reaction schema refuses coerced arrays, objects and numbers', () => {
  const payload = event('a', { kind: 'reaction', reaction: '♥' }).payload;
  for (const reaction of [['♥'], { toString: () => '♥' }, 0, true, undefined])
    assert.throws(() => parseSocial({ ...payload, reaction }), /Unsupported reaction/);
  assert.equal(parseSocial({ ...payload, reaction: null }).kind, 'reaction');
});
