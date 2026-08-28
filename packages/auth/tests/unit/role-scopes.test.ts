import { describe, expect, test } from 'bun:test';
import { rolesToScopes } from '../../index';

describe('rolesToScopes', () => {
  test('expands known roles in role and mapping order', () => {
    expect(
      rolesToScopes(['viewer', 'admin'], {
        viewer: ['logs:read'],
        admin: ['logs:write', 'api-keys:write'],
      }),
    ).toEqual(['logs:read', 'logs:write', 'api-keys:write']);
  });

  test('deduplicates grants shared by multiple roles', () => {
    expect(
      rolesToScopes(['viewer', 'admin'], {
        viewer: ['logs:read'],
        admin: ['logs:read', 'logs:write', 'logs:write'],
      }),
    ).toEqual(['logs:read', 'logs:write']);
  });

  test('ignores roles absent from the configured policy', () => {
    expect(rolesToScopes(['unknown', 'viewer'], { viewer: ['logs:read'] })).toEqual(['logs:read']);
  });

  test('returns no grants without a mapping or roles', () => {
    expect(rolesToScopes(['admin'])).toEqual([]);
    expect(rolesToScopes([], { admin: ['everything'] })).toEqual([]);
  });
});
