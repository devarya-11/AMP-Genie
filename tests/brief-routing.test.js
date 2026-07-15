'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { routeBrief, KEYWORD_MAP } = require('../server/brief-router');
const { MODULE_IDS } = require('../server/generate');

// ---- KEYWORD_MAP sanity -----------------------------------------------------

test('every KEYWORD_MAP key is a real module id in generate.js', () => {
  for (const moduleId of Object.keys(KEYWORD_MAP)) {
    assert.ok(MODULE_IDS.includes(moduleId), `"${moduleId}" is not a real module id`);
  }
});

// ---- the regression case that motivated this feature -----------------------

test('a restaurant catalogue/carousel brief routes to search, not quiz', () => {
  const result = routeBrief('New restaurants catalogue in a carousel format.', 'Food');
  assert.ok(result);
  assert.strictEqual(result.moduleId, 'search');
  assert.ok(result.matchedTerms.length > 0);
});

// ---- one representative brief per real module -------------------------------

test('routes a discount/reveal brief to reveal', () => {
  const result = routeBrief('Unlock a surprise offer with a discount code', 'Generic');
  assert.strictEqual(result.moduleId, 'reveal');
});

test('routes a personality-quiz brief to quiz', () => {
  const result = routeBrief('Take our quiz to find your perfect match', 'Generic');
  assert.strictEqual(result.moduleId, 'quiz');
});

test('routes a feedback/NPS brief to rating', () => {
  const result = routeBrief('Rate your last order and leave a review', 'Generic');
  assert.strictEqual(result.moduleId, 'rating');
});

test('routes a prize-wheel brief to spin', () => {
  const result = routeBrief('Spin the wheel for a lucky draw reward', 'Generic');
  assert.strictEqual(result.moduleId, 'spin');
});

test('routes a this-or-that brief to poll', () => {
  const result = routeBrief('Vote in our this or that poll', 'Generic');
  assert.strictEqual(result.moduleId, 'poll');
});

test('routes a lead-capture / waitlist brief to form', () => {
  const result = routeBrief('Build a launch waitlist where people sign up to get notified', 'Generic');
  assert.strictEqual(result.moduleId, 'form');
  assert.ok(result.matchedTerms.length > 0);
});

test('form loses a tie to a more specific module (it is ranked last)', () => {
  // A genuine 1-1 split: "unlock" (reveal) and "early access" (form) each match
  // once. Because form is last in KEYWORD_MAP and routeBrief's sort is stable,
  // the more specific module (reveal) keeps the lead on the tie.
  const result = routeBrief('Unlock early access', 'Generic');
  assert.strictEqual(result.moduleId, 'reveal');
  assert.strictEqual(result.matchedTerms.length, 1);
});

// ---- no-signal / edge cases --------------------------------------------------

test('returns null for a brief with no matching keywords', () => {
  assert.strictEqual(routeBrief('Just a generic weekend sale announcement', 'Generic'), null);
});

test('returns null for an empty or whitespace-only brief', () => {
  assert.strictEqual(routeBrief('', 'Generic'), null);
  assert.strictEqual(routeBrief('   ', 'Generic'), null);
  assert.strictEqual(routeBrief(undefined, 'Generic'), null);
});

test('matching is case-insensitive', () => {
  const result = routeBrief('SPIN THE WHEEL AND WIN', 'Generic');
  assert.strictEqual(result.moduleId, 'spin');
});

test('confidence is capped at 1 and scales with matched term count', () => {
  const one = routeBrief('Spin the wheel', 'Generic');
  const many = routeBrief('Spin the wheel for a lucky draw jackpot, spin to win big', 'Generic');
  assert.ok(one.confidence > 0 && one.confidence <= 1);
  assert.ok(many.confidence <= 1);
  assert.ok(many.matchedTerms.length >= one.matchedTerms.length);
});

test('picks the module with the most matched keywords when a brief mentions several', () => {
  // "menu" (search) matches once; "spin"+"wheel"+"lucky draw" (spin) match
  // three times — spin should win on keyword count.
  const result = routeBrief('Check our menu then spin the wheel for a lucky draw', 'Generic');
  assert.strictEqual(result.moduleId, 'spin');
});

test('a keyword substring of another matched keyword is not double-counted', () => {
  // "catalogue" contains "catalog" as a substring — this must count as one
  // match, not two, so it can't out-rank a module with only one real term.
  const result = routeBrief('Browse our catalogue', 'Generic');
  assert.strictEqual(result.moduleId, 'search');
  assert.strictEqual(result.matchedTerms.length, 2); // "browse" + "catalogue"
});
