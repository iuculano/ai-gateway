import { expect, test } from 'bun:test';
import { generateActorId, getActorType } from '../../index';

test('an actor id says what kind of actor it is, and is still a UUIDv7', () => {
  for (const type of ['user', 'api_key'] as const) {
    const id = generateActorId(type);
    expect(getActorType(id)).toBe(type);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
});

test('an id that was not made for an actor has no type', () => {
  expect(getActorType('01a0937a-9ff7-7aad-b600-673e01cde220')).toBeUndefined();
});
