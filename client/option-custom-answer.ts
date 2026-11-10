import { formatOptionAnswer, questionNumber, type OptionChoice, type OptionQuestion, type OptionQuestionSet } from './option-questions';

export type ConfirmedOptionAnswer =
  | ({ kind: 'option' } & OptionChoice)
  | { kind: 'custom'; letter: string; content: string };

export interface FormattedCustomAnswers {
  index: string;
  message: string;
}

// Parsed questions always contain original options in ascending A-H order.
export function customAnswerLetter(question: OptionQuestion): string {
  const last = question.options[question.options.length - 1]!;
  return String.fromCharCode(last.letter.charCodeAt(0) + 1);
}

export function formatCustomAnswers(
  set: OptionQuestionSet,
  answers: Record<number, ConfirmedOptionAnswer | undefined>,
  legacyIdentifiers = false,
): FormattedCustomAnswers | null {
  const tokens: string[] = [];
  const blocks: string[] = [];
  const ordinary: Record<number, OptionChoice> = {};
  let hasOrdinaryNote = false;

  for (let index = 0; index < set.questions.length; index++) {
    const question = set.questions[index]!;
    const answer = answers[index];
    if (!answer) return null;
    const token = `${legacyIdentifiers ? question.number ?? '' : questionNumber(set, index)}${answer.letter}`;
    if (answer.kind === 'option') {
      if (!question.options.some(option => option.letter === answer.letter)) return null;
      ordinary[index] = answer;
      if (answer.note?.trim()) hasOrdinaryNote = true;
    } else if (answer.kind === 'custom') {
      if (answer.letter !== customAnswerLetter(question) || typeof answer.content !== 'string' || !answer.content.trim()) return null;
      blocks.push(`${token}：\n${answer.content}`);
    } else {
      return null;
    }
    tokens.push(token);
  }

  const answerIndex = tokens.join(' ');
  if (blocks.length) {
    // The custom-message layout has no representation for ordinary notes.
    if (hasOrdinaryNote) return null;
    return { index: answerIndex, message: `${answerIndex}\n\n${blocks.join('\n\n')}` };
  }
  const message = formatOptionAnswer(set, ordinary, legacyIdentifiers);
  return message === null ? null : { index: answerIndex, message };
}
