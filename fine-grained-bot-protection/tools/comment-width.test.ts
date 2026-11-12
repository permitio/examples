import { RuleTester } from 'oxlint/plugins-dev';
import { describe, it } from 'vitest';
import plugin from '#tools/comment-width';

RuleTester.describe = describe;
RuleTester.it = it;

const rule = plugin.rules['line-comments'];
if (rule === undefined) throw new Error('comment-width has no line-comments rule');

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } });
const options = [{ maxLength: 40 }];

const wrapped = [
  '// The portal asks Permit before every',
  '// protected action, then records the',
  '// decision.',
  'export const a = 1;',
].join('\n');

tester.run('line-comments', rule, {
  valid: [
    { code: '// Fits in forty columns.\nexport const a = 1;', options },
    { code: '// A short line.\n// Another short line.\nexport const a = 1;', options },
    { code: '// https://example.test/a-very-long-path/that-cannot-break\nconst a = 1;', options },
    { code: 'const s = `\n// not a comment, only text inside a template string\n`;', options },
    { code: '/** A JSDoc comment is left to oxfmt, however long it runs on the line. */', options },
    { code: '// Éowyn, Éomer and Gríma fit in forty..\nexport const a = 1;', options },
    { code: wrapped, options },
  ],
  invalid: [
    {
      code: [
        '// The portal asks Permit before every protected action, then records the decision.',
        'export const a = 1;',
      ].join('\n'),
      options,
      output: wrapped,
      errors: [{ messageId: 'overflow', line: 1 }],
    },
    {
      code: [
        'function f() {',
        '  // A deny stops the request with 403',
        '  // before anything is written, and the panel shows why.',
        '  return 1;',
        '}',
      ].join('\n'),
      options,
      output: [
        'function f() {',
        '  // A deny stops the request with 403',
        '  // before anything is written, and the',
        '  // panel shows why.',
        '  return 1;',
        '}',
      ].join('\n'),
      errors: [{ messageId: 'overflow', line: 3 }],
    },
    {
      code: [
        '// The runner checks every decision and status code, one by one.',
        '// Run: bin/demo scenario <profile> s4.',
        'export const a = 1;',
      ].join('\n'),
      options,
      output: [
        '// The runner checks every decision and',
        '// status code, one by one.',
        '// Run: bin/demo scenario <profile> s4.',
        'export const a = 1;',
      ].join('\n'),
      errors: [{ messageId: 'overflow', line: 1 }],
    },
    {
      code: [
        '// First paragraph, short.',
        '//',
        '// Second paragraph runs past the limit of forty.',
        'export const a = 1;',
      ].join('\n'),
      options,
      output: [
        '// First paragraph, short.',
        '//',
        '// Second paragraph runs past the limit',
        '// of forty.',
        'export const a = 1;',
      ].join('\n'),
      errors: [{ messageId: 'overflow', line: 3 }],
    },
    {
      code: [
        '// 1. S1 creates the organization live, so it must not',
        '//    exist at the start.',
        '// 2. Short item.',
        'export const a = 1;',
      ].join('\n'),
      options,
      output: [
        '// 1. S1 creates the organization live,',
        '//    so it must not exist at the start.',
        '// 2. Short item.',
        'export const a = 1;',
      ].join('\n'),
      errors: [{ messageId: 'overflow', line: 1 }],
    },
    {
      code: [
        '// Example, which stays as written even when long:',
        '//     permit.check(user, action, resource)',
        'export const a = 1;',
      ].join('\n'),
      options,
      output: [
        '// Example, which stays as written even',
        '// when long:',
        '//     permit.check(user, action, resource)',
        'export const a = 1;',
      ].join('\n'),
      errors: [
        { messageId: 'overflow', line: 1 },
        { messageId: 'verbatim', line: 2 },
      ],
    },
    {
      code: '// oxlint-disable-next-line no-console -- a directive is never rewrapped\nconsole.log(1);',
      options,
      output: null,
      errors: [{ messageId: 'verbatim', line: 1 }],
    },
    {
      code: '// --- A section header that is far too long to fit ---\nexport const a = 1;',
      options,
      output: null,
      errors: [{ messageId: 'verbatim', line: 1 }],
    },
    {
      code: 'export const a = 1; // a trailing comment that runs past the limit',
      options,
      output: null,
      errors: [{ messageId: 'trailing', line: 1 }],
    },
  ],
});
