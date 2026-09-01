import { describe, expect, test } from 'bun:test';
import { normalizeRoles, normalizeScopes } from '../../index';

describe('normalizeScopes', () => {
  test('splits a space-delimited scope claim and removes empty segments', () => {
    expect(normalizeScopes('openid  logs:read logs:write ')).toEqual(['openid', 'logs:read', 'logs:write']);
    expect(normalizeScopes('')).toEqual([]);
  });

  test('accepts string arrays while rejecting untrusted non-string entries', () => {
    expect(normalizeScopes(['logs:read', 42, '', null, 'logs:write'])).toEqual(['logs:read', 'logs:write']);
  });

  test('returns no scopes for missing and invalid claim shapes', () => {
    for (const value of [undefined, null, 42, true, { scope: 'logs:read' }]) {
      expect(normalizeScopes(value)).toEqual([]);
    }
  });
});

describe('normalizeRoles', () => {
  test('accepts one bare role and treats an empty string as no roles', () => {
    expect(normalizeRoles('admin')).toEqual(['admin']);
    expect(normalizeRoles('')).toEqual([]);
  });

  test('filters untrusted array entries instead of casting them to roles', () => {
    expect(normalizeRoles(['admin', false, '', null, 'viewer'])).toEqual(['admin', 'viewer']);
  });

  test('uses object keys for Zitadel role maps', () => {
    expect(
      normalizeRoles({
        admin: { 'tenant-1': 'issuer.example' },
        viewer: { 'tenant-1': 'issuer.example' },
      }),
    ).toEqual(['admin', 'viewer']);
  });

  test('returns no roles for missing and invalid claim shapes', () => {
    for (const value of [undefined, null, 42, true]) {
      expect(normalizeRoles(value)).toEqual([]);
    }
  });
});
