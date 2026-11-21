import { expect, test } from 'bun:test';
import { SCOPES } from '../../../gateway-backend/src/authorization';
import { SCOPE_OPTIONS } from '../../src/lib/data/scopes';

test('the scopes offered for a key are exactly the ones the backend knows', () => {
  // The API rejects a key that grants an unknown scope, and a scope missing
  // here could never be granted from the dashboard.
  const offered = SCOPE_OPTIONS.map((option) => option.id);

  expect(offered).toEqual(Object.values(SCOPES));
});
