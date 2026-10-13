import type { DecisionQuestion } from '$lib/api/decisions';

export type QuestionType = DecisionQuestion['type'];

export const QUESTION_TYPES: QuestionType[] = ['predicate', 'choice', 'score'];

/** Per-type accents, from the same palette as the chat roles. */
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

/** The editor's flat draft as the request's question. */
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

  const options =
    question.type === 'choice'
      ? question.choices.map((choice) => ({ value: choice.value, description: choice.description }))
      : question.type === 'score'
        ? question.levels.map((level) => ({ value: level.label, description: level.description }))
        : [];

  return { type: question.type, name: question.name, instructions: question.instructions, options: options };
}
