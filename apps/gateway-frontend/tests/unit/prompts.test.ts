import { expect, test } from 'bun:test';
import { extractVariables } from '../../src/lib/data/prompts';

test('reserved prompt variables are left to the backend, including unknown names', () => {
  expect(extractVariables('{{ aig.date }} {{ customer }} {{ aig.future_variable }} {{ customer }}')).toEqual({
    builtins: ['aig.date', 'aig.future_variable'],
    inputs: ['customer'],
  });
});

test('ordinary inputs remain case-sensitive and preserve first appearance order', () => {
  expect(extractVariables('{{ topic }} {{ AIG.name }} {{ name }} {{ topic }}')).toEqual({
    builtins: [],
    inputs: ['topic', 'AIG.name', 'name'],
  });
});
