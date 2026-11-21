import type { DecisionQuestion } from '#lib/api/decisions.ts';

export type QuestionType = DecisionQuestion['type'];

export const QUESTION_TYPES: QuestionType[] = ['predicate', 'choice', 'score'];

/**
 * Per-type accents, from the same palette as the chat roles.
 */
export const QUESTION_TYPE_COLORS: Record<QuestionType, string> = {
  predicate: '#10b981',
  choice: '#60a5fa',
  score: '#c084fc',
};

/**
 * One editable question.
 *
 * Flat rather than the request's union. `options` holds a choice question's
 * choices or a score question's levels, so switching the type keeps the rows
 * already typed.
 */
export interface DraftQuestion {
  type: QuestionType;
  name: string;
  instructions: string;
  options: { value: string; description: string }[];
}

export function emptyQuestion(type: QuestionType = 'predicate'): DraftQuestion {
  return { type: type, name: '', instructions: '', options: [] };
}

/**
 * The editor's flat draft as the request's question.
 */
export function toQuestion(draft: DraftQuestion): DecisionQuestion {
  const base = { name: draft.name.trim(), instructions: draft.instructions.trim() };
  const options = draft.options.map((option) => ({
    value: option.value.trim(),
    description: option.description.trim(),
  }));

  switch (draft.type) {
    case 'predicate':
      return { type: 'predicate', ...base };

    case 'choice':
      return { type: 'choice', ...base, choices: options };

    case 'score':
      return {
        type: 'score',
        ...base,
        levels: options.map((option) => ({ label: option.value, description: option.description })),
      };
  }
}

function optionsOf(question: DecisionQuestion): DraftQuestion['options'] {
  switch (question.type) {
    case 'choice':
      return question.choices.map((choice) => ({ value: choice.value, description: choice.description }));

    case 'score':
      return question.levels.map((level) => ({ value: level.label, description: level.description }));

    default:
      return [];
  }
}

/**
 * A request question back as an editor draft.
 *
 * Throws on a question the editor can't show, since it usually comes from
 * hand-written JSON.
 */
export function toDraft(question: DecisionQuestion): DraftQuestion {
  if (!QUESTION_TYPES.includes(question.type)) {
    throw new Error(`Unknown question type ${String(question.type)}`);
  }

  return {
    type: question.type,
    name: question.name,
    instructions: question.instructions,
    options: optionsOf(question),
  };
}

/**
 * What stops a decision request being sent, as a sentence for the reader, or
 * null when it is ready.
 *
 * The gateway would refuse most of these itself, but its messages name schema
 * paths such as questions[2].choices[0].description, where this can name the
 * question.
 */
export function decisionProblem(input: string, questions: DraftQuestion[]): string | null {
  if (input.trim().length === 0) {
    return 'Write the input the questions are about.';
  }

  const names = new Set<string>();

  for (const [index, draft] of questions.entries()) {
    const name = draft.name.trim();
    const label = name || `Question ${index + 1}`;

    if (!name || !draft.instructions.trim()) {
      return `${label} needs a name and instructions.`;
    }

    // The gateway accepts two questions with one name, but the answers come
    // back keyed by name, so one would overwrite the other without a word.
    if (names.has(name)) {
      return `Two questions are named ${name}.`;
    }

    names.add(name);

    if (draft.type === 'predicate') {
      continue;
    }

    if (draft.options.some((option) => !option.value.trim() || !option.description.trim())) {
      return `Fill in every ${draft.type === 'choice' ? 'choice' : 'level'} of ${label}.`;
    }

    const values = draft.options.map((option) => option.value.trim());

    if (draft.type === 'choice' && new Set(values).size !== values.length) {
      return `${label} has two choices with the same value.`;
    }
  }

  return null;
}
