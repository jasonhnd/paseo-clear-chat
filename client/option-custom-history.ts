import { customAnswerLetter, formatCustomAnswers, type ConfirmedOptionAnswer } from './option-custom-answer';
import { questionNumber, type OptionQuestionSet } from './option-questions';

/**
 * Decode a formatter message into question-indexed ConfirmedOptionAnswer values.
 * Returns null for ordinary-only messages, invalid or duplicate identifiers, and
 * ambiguous block-shaped content (including extra or repeated block markers).
 * Callers should retain the original message when decoding fails.
 */
export function parseCustomAnswerHistory(
  set: OptionQuestionSet,
  message: string,
): Record<number, ConfirmedOptionAnswer> | null {
  return parseHistory(set, message, false) ?? parseHistory(set, message, true);
}

function parseHistory(set: OptionQuestionSet, message: string, legacyIdentifiers: boolean): Record<number, ConfirmedOptionAnswer> | null {
  const separator = message.indexOf('\n\n');
  if (separator < 0) return null;
  const tokens = message.slice(0, separator).split(' ');
  if (tokens.length !== set.questions.length) return null;

  const answers: Record<number, ConfirmedOptionAnswer> = {};
  const identifiers = new Set<string>();
  const possibleTokens = new Set<string>();
  const custom: { index: number; token: string; letter: string }[] = [];
  for (let index = 0; index < set.questions.length; index++) {
    const question = set.questions[index]!;
    const identifier = String(legacyIdentifiers ? question.number ?? '' : questionNumber(question, index));
    if (!/^(?:[0-9]+|[A-Z][0-9]+)?$/.test(identifier) || identifiers.has(identifier)) return null;
    identifiers.add(identifier);
    const letters = question.options.map(option => option.letter);
    if (!letters.length || letters.some((letter, i) => !/^[A-H]$/.test(letter) || (i > 0 && letter <= letters[i - 1]!))) return null;
    const synthetic = customAnswerLetter(question);
    for (const letter of [...letters, synthetic]) {
      const candidate = identifier + letter;
      if (possibleTokens.has(candidate)) return null;
      possibleTokens.add(candidate);
    }
    const token = tokens[index]!;
    const letter = token.slice(identifier.length);
    if (token !== identifier + letter) return null;
    if (letters.includes(letter)) answers[index] = { kind: 'option', letter };
    else if (letter === synthetic) custom.push({ index, token, letter });
    else return null;
  }
  if (!custom.length) return null;

  const body = message.slice(separator + 2);
  // A marker is only a complete label at the start or after a blank line.
  // Unknown marker-shaped labels are also ambiguous with extra blocks.
  const marker = /(?:^|\n\n)([A-Z]?[0-9]*[A-Z])：\n/g;
  const matches = [...body.matchAll(marker)];
  if (matches.length !== custom.length) return null;
  for (let i = 0; i < custom.length; i++) {
    const expected = custom[i]!;
    const match = matches[i]!;
    if (match[1] !== expected.token || (i === 0 && match.index !== 0)) return null;
    const start = match.index! + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : body.length;
    const content = body.slice(start, end);
    // A label immediately at the start of content is ambiguous too.
    if (!content.trim() || /^[A-Z]?[0-9]*[A-Z]：\n/.test(content)) return null;
    answers[expected.index] = { kind: 'custom', letter: expected.letter, content };
  }
  return formatCustomAnswers(set, answers, legacyIdentifiers)?.message === message ? answers : null;
}
