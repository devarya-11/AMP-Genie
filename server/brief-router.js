'use strict';

// Deterministic Tier-1 keyword router: maps a free-text campaign brief to one
// of the real module ids in generate.js's MODULES, so the brief can actually
// steer which module gets built instead of only supplying copy overrides.
// LLM-assisted routing (Tier 2) is a deliberate future follow-on, not this.

const { MODULE_IDS } = require('./generate');

// Keyword -> moduleId. Keys are lowercase substrings matched against the
// lowercased brief text.
const KEYWORD_MAP = {
  reveal: ['reveal', 'discount', 'coupon', 'promo code', 'unlock', 'surprise offer', 'hidden offer'],
  search: ['catalogue', 'catalog', 'carousel', 'browse', 'search', 'filter', 'collection', 'menu', 'restaurants', 'product range', 'new arrivals', 'explore our'],
  quiz: ['quiz', 'match', 'personality', 'which one', 'find your', 'find the right'],
  rating: ['rate', 'rating', 'review', 'feedback', 'nps', 'survey', 'stars'],
  spin: ['spin', 'wheel', 'lucky draw', 'jackpot', 'spin to win'],
  poll: ['poll', 'vote', 'this or that', 'pick one', 'choose between'],
};

// If a module is ever renamed/removed in generate.js, fail loudly here
// instead of silently routing briefs to a module id that no longer exists.
for (const moduleId of Object.keys(KEYWORD_MAP)) {
  if (!MODULE_IDS.includes(moduleId)) {
    throw new Error(`brief-router: "${moduleId}" is not a real module id (${MODULE_IDS.join(', ')})`);
  }
}

// Some keywords are substrings of others in the same module's list (e.g.
// "spin" inside "spin to win", "catalog" inside "catalogue") — without this,
// a single mention would double-count and skew scores between modules.
// Drop any matched keyword that's wholly contained in another, longer
// matched keyword for that same module.
function dedupeSubsumed(keywords) {
  return keywords.filter((kw, i) => !keywords.some((other, j) => i !== j && other.length > kw.length && other.includes(kw)));
}

function routeBrief(briefText, vertical) { // eslint-disable-line no-unused-vars
  const text = String(briefText || '').toLowerCase().trim();
  if (!text) return null;

  const matched = {};
  for (const [moduleId, keywords] of Object.entries(KEYWORD_MAP)) {
    for (const kw of keywords) {
      if (text.includes(kw)) {
        (matched[moduleId] = matched[moduleId] || []).push(kw);
      }
    }
  }
  for (const moduleId of Object.keys(matched)) {
    matched[moduleId] = dedupeSubsumed(matched[moduleId]);
  }

  const ranked = Object.keys(matched).sort((a, b) => matched[b].length - matched[a].length);
  if (!ranked.length) return null;

  const moduleId = ranked[0];
  const matchedTerms = matched[moduleId];
  // Fraction of matched terms out of 3, capped at 1 — one generic keyword
  // hit shouldn't claim full confidence.
  const confidence = Math.min(1, matchedTerms.length / 3);

  return { moduleId, confidence, matchedTerms };
}

// Structured signals pulled deterministically from the brief that the LLM copy
// layer is deliberately not allowed to set — chiefly the headline offer
// percentage, which the modules render as the big "X% OFF" number. Living here
// (next to routeBrief) keeps the Express route and the Pages Function deriving
// the same number from the same brief. Only a whole percentage written with a
// literal "%" is taken, so "top 20 products" can't be misread as 20% off;
// anything outside 1-99 is dropped and left to the module's own default.
function briefSignals(briefText) {
  const out = {};
  const m = String(briefText || '').match(/(\d{1,3})\s*%/);
  if (m) {
    const pct = Math.round(Number(m[1]));
    if (Number.isFinite(pct) && pct >= 1 && pct <= 99) out.discount = pct;
  }
  return out;
}

module.exports = { routeBrief, briefSignals, KEYWORD_MAP };
