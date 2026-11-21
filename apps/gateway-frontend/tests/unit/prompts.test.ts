import { expect, test } from 'bun:test';
import { carryValues, extractVariables, suppliedVariables, tagKeys } from '../../src/lib/data/prompts';

test('reserved prompt variables are left to the backend, including unknown names', () => {
  const variables = extractVariables('{{ aig.date }} {{ customer }} {{ aig.future_variable }} {{ customer }}');

  expect(variables).toEqual({ builtins: ['aig.date', 'aig.future_variable'], inputs: ['customer'] });
});

test('ordinary inputs remain case-sensitive and preserve first appearance order', () => {
  const variables = extractVariables('{{ topic }} {{ AIG.name }} {{ name }} {{ topic }}');

  expect(variables).toEqual({ builtins: [], inputs: ['topic', 'AIG.name', 'name'] });
});

test('tag keys are listed once each across every prompt, tagged or not', () => {
  const keys = tagKeys([{ env: 'prod' }, null, { env: 'test', team: 'billing' }]);

  expect(keys).toEqual(['env', 'team']);
});

test('what was typed is kept for the variables a new template still asks for', () => {
  const typed = { customer: 'Ada', tone: 'formal' };

  expect(carryValues(['customer', 'language'], typed)).toEqual({ customer: 'Ada', language: '' });
});

test('only the variables the template asks for are sent, and only once filled in', () => {
  const typed = { customer: 'Ada', language: '', tone: 'left over from another prompt' };

  expect(suppliedVariables(['customer', 'language'], typed)).toEqual({ customer: 'Ada' });
});
