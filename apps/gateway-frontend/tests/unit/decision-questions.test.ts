import { expect, test } from 'bun:test';
import type { DecisionQuestion } from '../../src/lib/api/decisions';
import { toDraft, toQuestion } from '../../src/lib/data/decision-questions';

const questions: DecisionQuestion[] = [
  { type: 'predicate', name: 'spam', instructions: 'Is this spam?' },
  {
    type: 'choice',
    name: 'team',
    instructions: 'Which team?',
    choices: [
      { value: 'billing', description: 'Charges and refunds' },
      { value: 'sales', description: 'Pricing' },
    ],
  },
  {
    type: 'score',
    name: 'urgency',
    instructions: 'How urgent?',
    levels: [
      { label: 'low', description: 'Can wait' },
      { label: 'high', description: 'Right now' },
    ],
  },
];

test.each(questions)('a $type question survives the trip through the form', (question) => {
  expect(toQuestion(toDraft(question))).toEqual(question);
});

test('a question type the form does not know is refused', () => {
  const ranking = { type: 'ranking', name: 'x', instructions: 'y' } as unknown as DecisionQuestion;

  expect(() => toDraft(ranking)).toThrow('Unknown question type ranking');
});
