import { expect, test } from 'bun:test';
import type { DecisionQuestion } from '../../src/lib/api/decisions';
import { type DraftQuestion, decisionProblem, toDraft, toQuestion } from '../../src/lib/data/decision-questions';

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

// decisionProblem

const SPAM: DraftQuestion = { type: 'predicate', name: 'spam', instructions: 'Is this spam?', options: [] };

/**
 * A choice question that is ready to send, with two teams to pick from.
 */
function team(options = ['billing', 'sales']): DraftQuestion {
  return {
    type: 'choice',
    name: 'team',
    instructions: 'Which team?',
    options: options.map((value) => ({ value: value, description: `Goes to ${value}` })),
  };
}

test('questions that are filled in are ready to send', () => {
  expect(decisionProblem('A message', [SPAM, team()])).toBeNull();
});

test('there has to be something to ask about', () => {
  expect(decisionProblem('   ', [SPAM])).toBe('Write the input the questions are about.');
});

test('a question with no name is called by its place in the list', () => {
  const unnamed = { ...SPAM, name: ' ' };

  expect(decisionProblem('A message', [SPAM, unnamed])).toBe('Question 2 needs a name and instructions.');
  expect(decisionProblem('A message', [{ ...SPAM, instructions: '' }])).toBe('spam needs a name and instructions.');
});

test('two questions cannot share a name, because the answers come back keyed by it', () => {
  expect(decisionProblem('A message', [SPAM, { ...team(), name: ' spam ' }])).toBe('Two questions are named spam.');
});

test('every choice and level has to be filled in, and is named for what it is', () => {
  const blankChoice = { ...team(), options: [{ value: 'billing', description: ' ' }] };
  const blankLevel: DraftQuestion = { ...team(), type: 'score', options: [{ value: '', description: 'Can wait' }] };

  expect(decisionProblem('A message', [blankChoice])).toBe('Fill in every choice of team.');
  expect(decisionProblem('A message', [blankLevel])).toBe('Fill in every level of team.');
});

test('choices cannot repeat a value, though the levels of a score may', () => {
  const repeated = team(['billing', ' billing']);

  expect(decisionProblem('A message', [repeated])).toBe('team has two choices with the same value.');
  expect(decisionProblem('A message', [{ ...repeated, type: 'score' }])).toBeNull();
});
