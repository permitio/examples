import { definePlugin, defineRule, type Comment, type Context } from '@oxlint/plugins';

/**
 * Keeps `//` comments within the print width, the way oxfmt's `jsdoc` option keeps JSDoc comments.
 * A paragraph with a line past the limit is rewrapped by `oxlint --fix` (`pnpm fix`); paragraphs
 * that fit are left as written. Directives, `// ---` headers and indented samples are never
 * rewrapped, and a trailing comment after code is reported for a person to move.
 */

const DEFAULT_MAX_LENGTH = 100;
const LIST_ITEM = /^([-*+]|\d+[.)]) +/;
const VERBATIM = /^(---|@ts-|oxlint-|eslint-|prettier-|#region|#endregion)/;
const SENTENCE_END = /[.:!?]$/;
const SENTENCE_START = /^[A-Z`]/;

/** One `//` line of a run: the text after `// `, or `verbatim` when it must stay as written. */
type Part =
  | { kind: 'blank' | 'verbatim'; comment: Comment }
  | { kind: 'text'; comment: Comment; text: string };

/** Lines rewrapped together: a plain paragraph, or a list item with its hanging lines. */
interface Paragraph {
  marker: string;
  words: string[];
  comments: Comment[];
}

const width = (line: string) => [...line].length;

function partOf(comment: Comment): Part {
  if (comment.value.trim() === '') return { kind: 'blank', comment };
  if (!comment.value.startsWith(' ')) return { kind: 'verbatim', comment };
  const text = comment.value.slice(1);
  if (VERBATIM.test(text)) return { kind: 'verbatim', comment };
  return { kind: 'text', comment, text };
}

/** Splits one run of full-line comments into the paragraphs that can be rewrapped. */
function paragraphsOf(run: readonly Comment[]): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let current: Paragraph | undefined;
  let previous = '';
  for (const part of run.map(partOf)) {
    if (part.kind !== 'text') {
      current = undefined;
      continue;
    }
    // A line that starts a sentence after one that ended a sentence keeps its own line, so notes
    // such as `// Run: bin/demo …` stay apart from the prose above them.
    const newSentence = SENTENCE_END.test(previous) && SENTENCE_START.test(part.text);
    previous = part.text.trim();
    const item = LIST_ITEM.exec(part.text);
    const hanging = current !== undefined && current.marker !== '';
    if (item) {
      current = { marker: item[0], words: [], comments: [] };
      paragraphs.push(current);
      current.words.push(...part.text.slice(item[0].length).split(/\s+/));
    } else if (part.text.startsWith(' ')) {
      // An indented line continues a list item at the item's indent; anything else is a sample.
      const indent = current?.marker.length ?? 0;
      const continues = hanging && part.text.slice(0, indent).trim() === '';
      if (!continues || current === undefined || /^\s/.test(part.text.slice(indent))) {
        current = undefined;
        continue;
      }
      current.words.push(...part.text.trim().split(/\s+/));
    } else {
      if (current === undefined || hanging || newSentence) {
        current = { marker: '', words: [], comments: [] };
        paragraphs.push(current);
      }
      current.words.push(...part.text.trim().split(/\s+/));
    }
    current.comments.push(part.comment);
  }
  return paragraphs;
}

/** Greedy wrap of `words` into `// ` lines that fit `maxLength` after `indent`. */
function wrap(paragraph: Paragraph, indent: string, maxLength: number): string[] {
  const first = `// ${paragraph.marker}`;
  const rest = `// ${' '.repeat(paragraph.marker.length)}`;
  const lines: string[] = [];
  let line = '';
  for (const word of paragraph.words.filter((w) => w !== '')) {
    const prefix = lines.length === 0 ? first : rest;
    if (line !== '' && width(indent + prefix + line + ' ' + word) > maxLength) {
      lines.push(prefix + line);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  lines.push((lines.length === 0 ? first : rest) + line);
  return lines;
}

/** Consecutive full-line `//` comments at the same indent, with the text before each line. */
function runsOf(context: Context, comments: readonly Comment[]) {
  const { text } = context.sourceCode;
  const runs: Array<{ indent: string; comments: Comment[] }> = [];
  const trailing: Comment[] = [];
  let previous: { indent: string; line: number; comments: Comment[] } | undefined;
  for (const comment of comments) {
    const lineStart = text.lastIndexOf('\n', comment.start - 1) + 1;
    const indent = text.slice(lineStart, comment.start);
    if (indent.trim() !== '') {
      trailing.push(comment);
      previous = undefined;
      continue;
    }
    const line = comment.loc.start.line;
    if (previous && previous.indent === indent && previous.line === line - 1) {
      previous.comments.push(comment);
      previous.line = line;
    } else {
      previous = { indent, line, comments: [comment] };
      runs.push(previous);
    }
  }
  return { runs, trailing };
}

const lineComments = defineRule({
  meta: {
    type: 'layout',
    fixable: 'whitespace',
    docs: { description: 'Keep `//` comments within the print width.' },
    messages: {
      overflow: 'This comment runs past {{max}} columns. Run `pnpm fix` to rewrap it.',
      trailing: 'This trailing comment runs past {{max}} columns. Move it to its own line above.',
      verbatim: 'This comment runs past {{max}} columns and is kept as written. Shorten it.',
    },
    schema: [
      {
        type: 'object',
        properties: { maxLength: { type: 'integer', minimum: 1 } },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] as { maxLength?: number } | undefined;
    const maxLength = options?.maxLength ?? DEFAULT_MAX_LENGTH;
    const data = { max: String(maxLength) };
    const tooLong = (comment: Comment) =>
      comment.loc.start.column + width(`//${comment.value}`) > maxLength;
    return {
      Program() {
        const comments = context.sourceCode.getAllComments().filter((c) => c.type === 'Line');
        const { runs, trailing } = runsOf(context, comments);
        for (const comment of trailing.filter(tooLong)) {
          context.report({ loc: comment.loc, messageId: 'trailing', data });
        }
        for (const run of runs) {
          const paragraphs = paragraphsOf(run.comments);
          const wrapped = new Set(paragraphs.flatMap((p) => p.comments));
          for (const comment of run.comments.filter((c) => !wrapped.has(c) && tooLong(c))) {
            context.report({ loc: comment.loc, messageId: 'verbatim', data });
          }
          for (const paragraph of paragraphs) {
            const long = paragraph.comments.find(tooLong);
            if (long === undefined) continue;
            const lines = wrap(paragraph, run.indent, maxLength);
            const original = paragraph.comments.map((c) => `//${c.value}`);
            if (lines.join('\n') === original.join('\n')) continue;
            const first = paragraph.comments[0];
            const last = paragraph.comments.at(-1);
            if (first === undefined || last === undefined) continue;
            context.report({
              loc: long.loc,
              messageId: 'overflow',
              data,
              fix: (fixer) =>
                fixer.replaceTextRange([first.start, last.end], lines.join(`\n${run.indent}`)),
            });
          }
        }
      },
    };
  },
});

export default definePlugin({
  meta: { name: 'comment-width' },
  rules: { 'line-comments': lineComments },
});
