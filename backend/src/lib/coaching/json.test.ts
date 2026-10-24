import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonObject, firstTextBlock, parseLlmJson } from './json.js';

/**
 * These two helpers stand between the model's reply and every coaching stage.
 * The old parse handled exactly one shape — a bare object, optionally fenced —
 * and a lead-in sentence was enough to fail a whole pack generation with the
 * reply swallowed. The cases below are the shapes models actually produce.
 */

const BRIEF = '{"overview":[{"claim":"Acme sells widgets","sourceUrl":"https://acme.com"}]}';

test('a bare JSON object parses', () => {
  assert.deepEqual(extractJsonObject(BRIEF), BRIEF);
  assert.equal(parseLlmJson<{ overview: unknown[] }>(BRIEF, 'brief', 'x').overview.length, 1);
});

test('a markdown fence is stripped', () => {
  assert.deepEqual(extractJsonObject('```json\n' + BRIEF + '\n```'), BRIEF);
});

test('a lead-in sentence no longer breaks the parse', () => {
  // The failure that started this: "Here is the brief:" ahead of valid JSON.
  assert.deepEqual(extractJsonObject('Here is the brief:\n\n' + BRIEF), BRIEF);
});

test('trailing commentary after the object is dropped', () => {
  assert.deepEqual(extractJsonObject(BRIEF + '\n\nLet me know if you need more.'), BRIEF);
});

test('a closed fence followed by a note is dropped', () => {
  assert.deepEqual(extractJsonObject('```json\n' + BRIEF + '\n```\n\nNote: scores are strict.'), BRIEF);
});

test('prose on both sides is dropped', () => {
  assert.deepEqual(extractJsonObject('Sure!\n' + BRIEF + '\nHope that helps.'), BRIEF);
});

test('braces inside strings do not truncate the object', () => {
  // Slicing to the LAST closing brace is what makes this safe — an inner "}"
  // in a claim must not end the slice early.
  const withBrace = '{"overview":[{"claim":"Uses the {handlebars} syntax","sourceUrl":"https://a.co"}]}';
  const parsed = JSON.parse(extractJsonObject('Note:\n' + withBrace)!) as {
    overview: { claim: string }[];
  };
  assert.equal(parsed.overview[0].claim, 'Uses the {handlebars} syntax');
});

test('a reply with no object at all returns null rather than throwing', () => {
  assert.equal(extractJsonObject('I could not find any information about this company.'), null);
});

test('genuinely broken JSON still throws, carrying statusCode and step', () => {
  // Real failures must stay failures — this helper is lenient about wrapping,
  // never about malformed content.
  assert.throws(
    () => parseLlmJson('{"overview": [', 'company brief', 'company-research-synthesis'),
    (err: unknown) => {
      const e = err as { message: string; statusCode: number; step: string };
      assert.match(e.message, /company brief/);
      assert.equal(e.statusCode, 500);
      assert.equal(e.step, 'company-research-synthesis');
      return true;
    },
  );
});

test('firstTextBlock skips a leading non-text block', () => {
  // Indexing content[0] blind reported "came back empty" when the text was
  // sitting one block behind a thinking block.
  const content = [{ type: 'thinking', thinking: '...' }, { type: 'text', text: BRIEF }];
  assert.equal(firstTextBlock(content), BRIEF);
});

test('firstTextBlock ignores empty text and reports nothing found', () => {
  assert.equal(firstTextBlock([{ type: 'text', text: '   ' }]), null);
  assert.equal(firstTextBlock([]), null);
  assert.equal(firstTextBlock([{ type: 'tool_use' }]), null);
});
