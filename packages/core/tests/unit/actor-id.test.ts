import { expect, test } from 'bun:test';
import { ACTOR_TYPES, generateActorId, getActorType } from '../../index';

test('an actor id says what kind of actor it is, and is still a UUIDv7', () => {
  for (const type of ACTOR_TYPES) {
    const id = generateActorId(type);
    expect(getActorType(id)).toBe(type);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
});

test('the type is the last hex digit', () => {
  expect(getActorType('01a0937a-9ff7-7aad-b600-673e01cde220')).toBe('unknown');
  expect(getActorType('01a0937a-9ff7-7aad-b600-673e01cde221')).toBe('user');
  expect(getActorType('01a0937a-9ff7-7aad-b600-673e01cde222')).toBe('api_key');
  expect(getActorType('01a0937a-9ff7-7aad-b600-673e01cde223')).toBe('system');
});

test('an id whose last digit is no actor type reads as unknown', () => {
  expect(getActorType('01a0937a-9ff7-7aad-b600-673e01cde22f')).toBe('unknown');
});
