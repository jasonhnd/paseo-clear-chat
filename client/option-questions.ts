export interface OptionQuestion {
  number: number | null;
  title: string;
  text: string;
  options: { letter: string; text: string; recommended: boolean }[];
}

export interface OptionQuestionSet {
  questions: OptionQuestion[];
  hint: boolean;
  recommendedFound: boolean;
}

export interface OptionChoice {
  letter: string;
  note?: string;
}

type Line = { text: string; index: number };
type Section = { number: number | null; lines: Line[] };

function stripPrefix(line: string, question: boolean): string {
  let value = line.trim();
  if (question) {
    while (value.startsWith('#')) value = value.slice(1);
    value = value.trimStart();
  }
  if ((value.startsWith('-') || value.startsWith('*')) && !value.startsWith('**')) {
    value = value.slice(1).trimStart();
  }
  if (value.startsWith('**')) value = value.slice(2);
  return value;
}

function questionLine(line: string): { number: number; text: string } | null {
  const value = stripPrefix(line, true);
  const match = /^([0-9０-９]+)[)）.、]\s*(.*)$/.exec(value);
  if (!match || !match[2]!.trim()) return null;
  const digits = match[1]!.replace(/[０-９]/g, digit => String(digit.charCodeAt(0) - 0xff10));
  const number = Number(digits);
  if (!Number.isSafeInteger(number)) return null;
  return { number, text: match[2]!.replace(/\*\*\s*$/, '').trim() };
}

function optionLine(line: string): { letter: string; text: string } | null {
  const value = stripPrefix(line, false);
  const match = /^([A-HＡ-Ｈ])(\*\*)?([)）.、:：]|[ \t])(.*)$/.exec(value);
  if (!match) return null;
  const text = match[4]!.replace(/\*\*\s*$/, '').trim();
  if (!text) return null;
  const code = match[1]!.charCodeAt(0);
  return { letter: String.fromCharCode(code >= 0xff21 ? code - 0xff21 + 65 : code), text };
}

function recommendation(line: string): string | null {
  const match = /(?:推荐(?:选)?[ \t]*(?:[:：][ \t]*)?|[Rr][Ee][Cc][Oo][Mm][Mm][Ee][Nn][Dd][Ee][Dd][ \t]*[:：][ \t]*|\b[Rr][Ee][Cc][Oo][Mm][Mm][Ee][Nn][Dd][ \t]+)([A-HＡ-Ｈ])(?![A-Za-zＡ-Ｚａ-ｚ])/.exec(line);
  if (!match) return null;
  const code = match[1]!.toUpperCase().charCodeAt(0);
  return String.fromCharCode(code >= 0xff21 ? code - 0xff21 + 65 : code);
}

function firstSentence(text: string): string {
  const end = /[!?。！？]|\.(?=\s|$)/.exec(text);
  return (end ? text.slice(0, end.index + 1) : text).slice(0, 100);
}

export function parseOptionQuestions(text: string): OptionQuestionSet | null {
  const lines: Line[] = [];
  let fence: { marker: string; length: number } | undefined;
  const source = text.split(/\r\n|\r|\n/);
  for (let index = 0; index < source.length; index++) {
    const line = source[index]!;
    if (fence) {
      const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
      if (closing && closing[1]!.charAt(0) === fence.marker && closing[1]!.length >= fence.length) fence = undefined;
      continue;
    }
    if (/^\s*>/.test(line)) continue;
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) {
      fence = { marker: opening[1]!.charAt(0), length: opening[1]!.length };
      continue;
    }
    lines.push({ text: line, index });
  }

  const sections: Section[] = [];
  let current: Section = { number: null, lines: [] };
  let hasNumbered = false;
  for (const line of lines) {
    const question = questionLine(line.text);
    if (question) {
      if (hasNumbered) sections.push(current);
      hasNumbered = true;
      current = { number: question.number, lines: [{ text: question.text, index: line.index }] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);

  const questions: OptionQuestion[] = [];
  let firstQuestionIndex: number | undefined;
  let recommendedFound = false;
  for (const section of sections) {
    const options: OptionQuestion['options'] = [];
    const before: string[] = [];
    const optionLines: string[][] = [];
    let optionStarted = false;
    let continuation = false;
    let invalid = false;
    for (const line of section.lines) {
      const option = optionLine(line.text);
      if (option) {
        optionStarted = true;
        continuation = true;
        if (option.letter.charCodeAt(0) !== 65 + options.length) invalid = true;
        options.push({ ...option, recommended: false });
        optionLines.push([option.text]);
      } else if (!optionStarted) {
        before.push(line.text);
      } else if (!line.text.trim()) {
        continuation = false;
      } else if (continuation) {
        optionLines[optionLines.length - 1]!.push(line.text.trim());
      }
    }
    if (invalid || options.length < 2) continue;
    for (let index = 0; index < options.length; index++) options[index]!.text = optionLines[index]!.join('\n');
    const questionText = before.join('\n').trim();
    const question: OptionQuestion = {
      number: section.number,
      title: firstSentence(questionText),
      text: questionText,
      options,
    };
    let recommended = options.find((_, index) => optionLines[index]!.some(line => /(?:(?<!不)推荐|(?<!\bnot[ \t]+)(?<![\w-])recommended\b)(?=[ \t]*(?:[)）,，.。!！]|$))/i.test(line)));
    if (!recommended) {
      for (const line of section.lines) {
        const letter = recommendation(line.text);
        if (letter) {
          recommended = options.find(option => option.letter === letter);
          if (recommended) break;
        }
      }
    }
    if (recommended) {
      recommended.recommended = true;
      recommendedFound = true;
    }
    questions.push(question);
    if (firstQuestionIndex === undefined) firstQuestionIndex = section.lines[0]?.index;
  }
  if (!questions.length) return null;
  const hint = lines.some(line => line.index > (firstQuestionIndex ?? -1) && /回法|回复|回一个字母|reply with|reply:|answer with|respond with/i.test(line.text));
  return hint || recommendedFound ? { questions, hint, recommendedFound } : null;
}

export function formatOptionAnswer(set: OptionQuestionSet, choices: Record<number, OptionChoice | undefined>): string | null {
  const answers: string[] = [];
  for (let index = 0; index < set.questions.length; index++) {
    const question = set.questions[index]!;
    const choice = choices[index];
    if (!choice || !question.options.some(option => option.letter === choice.letter)) return null;
    const prefix = question.number === null ? '' : String(question.number);
    const note = choice.note?.replace(/\r\n|\r|\n/g, ' ').trim();
    answers.push(`${prefix}${choice.letter}${note ? ` (${note})` : ''}`);
  }
  return answers.join(' ');
}
