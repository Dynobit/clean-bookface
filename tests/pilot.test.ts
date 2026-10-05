import test from 'node:test';
import assert from 'node:assert/strict';
import { pilotPhase, pilotAllowsRequest, pilotNotice } from '../src/pilot.js';

const config = { pilotReadOnlyAt: '2027-01-01T00:00:00Z', pilotEndsAt: '2027-01-15T00:00:00Z' };
const readOnly = Date.parse(config.pilotReadOnlyAt),
  end = Date.parse(config.pilotEndsAt);

test('pilot phases switch at exact fixed dates and remain fixed across recreated config', () => {
  assert.equal(pilotPhase({}, end), 'normal');
  assert.equal(pilotPhase(config, readOnly - 1), 'active');
  assert.equal(pilotPhase(config, readOnly), 'export-only');
  assert.equal(pilotPhase(config, end - 1), 'export-only');
  assert.equal(pilotPhase(config, end), 'ended');
  assert.equal(pilotPhase({ ...config }, end + 100000), 'ended');
  assert.equal(pilotPhase({ pilotEndsAt: config.pilotEndsAt }, readOnly), 'ended');
  assert.equal(pilotPhase(config, NaN), 'ended');
  assert.equal(pilotNotice({}, end), null);
  assert.match(pilotNotice(config, readOnly)!, /Download your account/);
});

test('export-only retains account access, exports and safety controls with exact routes', () => {
  for (const path of [
    '/actions/login',
    '/actions/logout',
    '/actions/recover',
    '/actions/password',
    '/actions/settings',
    '/actions/export',
    '/actions/delete-account',
    '/actions/posts/p1/delete',
    '/actions/posts/p1/revoke',
    '/actions/archive/a1/delete',
    '/actions/invites/i1/revoke',
    '/actions/friends/block',
    '/actions/report',
    '/actions/admin/reports/r1/resolve',
    '/actions/admin/members/u1/suspend',
    '/actions/admin/appeals/a1',
  ])
    assert.equal(pilotAllowsRequest(config, 'POST', path, readOnly), true, path);
  assert.equal(pilotAllowsRequest(config, 'GET', '/archive', readOnly), true);
  assert.equal(pilotAllowsRequest(config, 'GET', '/setup', readOnly), false);
  for (const path of [
    '/actions/setup',
    '/actions/register',
    '/actions/posts',
    '/actions/posts/p1/edit',
    '/actions/posts/p1/like',
    '/actions/posts/p1/grant',
    '/actions/posts/p1/comment',
    '/actions/invites',
    '/actions/invites/accept',
    '/actions/friends/request',
    '/actions/friends/f1/accept',
    '/api/imports',
    '/actions/photo',
    '/users/alice/inbox',
    '/actions/admin/hosts',
    '/actions/export/extra',
    '/actions/posts/a/b/delete',
  ]) {
    assert.equal(pilotAllowsRequest(config, 'POST', path, readOnly), false, path);
    assert.equal(pilotAllowsRequest(config, 'POST', path, readOnly - 1), true, path);
    assert.equal(pilotAllowsRequest({}, 'POST', path, end), true, path);
  }
  assert.equal(pilotAllowsRequest(config, 'PUT', '/actions/export', readOnly), false);
  assert.equal(pilotAllowsRequest(config, 'POST', '/actions/export', end), false);
  assert.equal(pilotAllowsRequest(config, 'GET', '/archive', end), false);
});
