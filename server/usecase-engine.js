'use strict';

// Use-case intelligence for v3: turns a brand dossier + campaign brief into a
// slate of pitch-ready AMP use-cases — business ideas mapped onto the six
// interaction modules in server/generate.js — steerable by follow-up team
// feedback, plus shapes a team-supplied idea into the same structure.
//
// Tiering follows the house religion (see server/brief-content.js): the
// hand-authored USECASE_LIBRARY below is the zero-key deterministic tier and
// the whole experience of every keyless deployment, so it is written as real
// lifecycle-marketing plays a Netcore pitch would use, not filler. When an
// LLM provider is configured it drafts brand-specific use-cases instead —
// but its output is schema-constrained JSON, re-validated locally against a
// strict allowlist (validateUseCase), and any shortfall or failure tops up
// from / falls back to the library. proposeUseCases() and shapeUserIdea()
// never throw and never hang past their timeout budget.
//
// THE ABSOLUTE RULE holds here too: an LLM never produces markup. A use-case
// is short descriptive strings plus an optional contentPlan of copy
// overrides that must survive brief-content's validatePlan before it can
// ever reach generate() — the same defense-in-depth as the brief composer.

const { MODULES, MODULE_IDS } = require('./generate');
const { FIELD_SCHEMAS, validatePlan, schemaFor } = require('./brief-content');
const { routeBrief } = require('./brief-router');
const { VERTICALS, applyBrand } = require('./content');
const { newId } = require('./store');
const {
  callClaude, callGemini, callGroq, callOllama, withTimeout,
} = require('./llm-providers');

const CLAUDE_MODEL = 'claude-haiku-4-5';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';
// Same opt-in gate as brief-content: a bare checkout never reaches out to an
// arbitrary local port unless OLLAMA_BASE_URL was explicitly set.
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || null;

// Use-case drafting is one richer call, not brief-content's best-of-N
// fan-out, so it gets a wider budget than composeContent's 8s. 30s, not 15:
// the response schema is the union of every module's contentPlan fields
// (8 modules since calc/report), and schema-constrained decoding on Gemini
// measurably needs >15s for it even with thinking disabled. Wall-clock wait
// on a fetch — no CPU cost on the Workers runtime, and the wizard shows a
// spinner for the duration.
const TIMEOUT_MS = 30000;

// Caps for the descriptive fields a use-case carries (contentPlan fields are
// capped by FIELD_SCHEMAS via validatePlan, not here).
const CAPS = { title: 80, businessGoal: 160, trigger: 80, kpi: 80 };

/* ------------------------------------------------------------------ *
 * USECASE_LIBRARY — the zero-key deterministic tier
 * ------------------------------------------------------------------ */

// One hand-authored use-case per module per vertical (Generic carries two
// extras so a count above six still fills without inventing content). '{b}'
// is the brand token, interpolated at propose time like server/content.js.
// Every contentPlan below must pass the REAL validatePlan for its module —
// tests enforce this — so no '<'/'>' anywhere and every field within its
// FIELD_SCHEMAS cap, with headroom left for brand-name interpolation.
const USECASE_LIBRARY = {
  Fashion: [
    {
      title: 'End-of-season private sale reveal for {b} VIPs',
      businessGoal: 'Reactivate lapsed high-AOV buyers with a members-only markdown before the public sale',
      trigger: 'winback, day 45 since last order',
      moduleId: 'reveal',
      kpi: 'code copy rate to sale collection CTR',
      contentPlan: {
        head: 'Your private {b} sale is open early',
        teaserText: 'You shopped with us this season, so you skip the queue. Tap to unlock your code before the public sale starts.',
        ctaLabel: 'Unlock early access',
        footerText: 'Early-access pricing holds for 48 hours for {b} members.',
      },
    },
    {
      title: 'New-arrivals rack you can browse inside the {b} email',
      businessGoal: 'Move new-season stock by letting subscribers filter the drop without leaving the inbox',
      trigger: 'new collection drop',
      moduleId: 'search',
      kpi: 'in-email filter interactions to PDP visits',
      contentPlan: {
        head: 'The new {b} drop, straight from the rack',
        footerText: 'Sizes sell through fast. Filtered picks link to live stock.',
      },
    },
    {
      title: 'Personal-stylist quiz that matches a {b} edit',
      businessGoal: 'Turn style preference into a first-party segment while recommending a shoppable edit',
      trigger: 'welcome journey, day 2',
      moduleId: 'quiz',
      kpi: 'quiz completion to recommended-edit CTR',
      contentPlan: {
        head: 'Three taps to your {b} edit',
        question: 'What is your off-duty uniform?',
        options: [
          { label: 'Relaxed layers', result: 'The {b} weekend edit: soft knits, wide-leg denim, low effort, high polish.' },
          { label: 'Tailored sharp', result: 'The {b} structured edit: crisp shirting and pleats that go desk to dinner.' },
          { label: 'Statement first', result: 'The {b} spotlight edit: bold colour and texture that carries the room.' },
        ],
        footerText: 'Your answer tunes what we send you next.',
      },
    },
    {
      title: 'Post-delivery fit check on your latest {b} order',
      businessGoal: 'Catch sizing issues before they become returns and feed fit data back to merchandising',
      trigger: '3 days after delivery',
      moduleId: 'rating',
      kpi: 'rating submit rate to exchange-not-return rate',
      contentPlan: {
        head: 'How did the fit land?',
        prompt: 'Rate your latest {b} order. A low score routes you straight to an easy exchange.',
        footerText: 'Ratings go to our fit team, not a black hole.',
      },
    },
    {
      title: 'Payday spin-to-win wardrobe treat from {b}',
      businessGoal: 'Convert payday browsers with a gamified discount instead of a flat blanket code',
      trigger: 'payday window, 1st of month',
      moduleId: 'spin',
      kpi: 'spin rate to coupon redemption',
      contentPlan: {
        head: 'Payday calls for a little luck',
        teaserText: 'One spin, one wardrobe upgrade. Every wedge is a real reward tonight.',
        footerText: 'One spin per customer. Code applies at {b} checkout.',
      },
    },
    {
      title: 'Restock vote: let {b} fans pick the next drop',
      businessGoal: 'Turn restock planning into engagement and a pre-launch demand signal',
      trigger: 'monthly engagement touch',
      moduleId: 'poll',
      kpi: 'vote rate to restock waitlist signups',
      contentPlan: {
        head: 'You are the {b} buying committee today',
        question: 'Which sold-out piece should come back first?',
        optionA: 'Suede boots',
        optionB: 'Knit sweaters',
        footerText: 'The winning pick goes into production first.',
      },
    },
    {
      title: 'Delivery-pass calculator inside the {b} email',
      businessGoal: 'Convert frequent orderers to the flat delivery pass by showing their own break-even maths live',
      trigger: 'third paid-delivery order in a month',
      moduleId: 'calc',
      kpi: 'calculator interactions to pass signups',
      contentPlan: {
        head: 'Would the {b} pass pay for itself?',
        promptText: 'Tap how often you order — delivery and return fees versus one flat pass, worked out on the spot.',
        ctaLabel: 'Try the pass',
        footerText: 'Estimates come from your own order history. Nothing is ever charged inside this email.',
      },
    },
    {
      title: 'Live order tracker: every {b} parcel in one email',
      businessGoal: 'Deflect where-is-my-order tickets by making the shipping email answer itself at open',
      trigger: 'order shipped',
      moduleId: 'report',
      kpi: 'tracker opens to support-ticket deflection',
      contentPlan: {
        head: 'Your {b} order, live at this moment',
        ctaLabel: 'Save preference',
        footerText: 'Status is fetched when you open the email, not when we hit send.',
      },
    },
  ],
  Food: [
    {
      title: 'Weekend cravings unlock: a hidden {b} deal',
      businessGoal: 'Lift weekend order frequency with a reveal-gated combo offer for recent-but-idle diners',
      trigger: 'Friday 5pm, ordered before but not this week',
      moduleId: 'reveal',
      kpi: 'code copy rate to weekend order rate',
      contentPlan: {
        head: 'Your Friday {b} treat is hiding here',
        teaserText: 'We saved a weekend-only deal for regulars. Tap to see what is cooking.',
        ctaLabel: 'Show my deal',
        footerText: 'Valid Friday to Sunday on orders from {b}.',
      },
    },
    {
      title: "In-inbox menu browser for tonight's {b} order",
      businessGoal: 'Shorten decision time by letting diners filter mains, sides and desserts inside the email',
      trigger: 'dinner-decision window, 6pm daily',
      moduleId: 'search',
      kpi: 'menu filter taps to add-to-cart rate',
      contentPlan: {
        head: "Tonight's {b} menu, zero app-hopping",
        itemNames: ['Wood-Fired Margherita', 'Smash Burger Combo', 'Korean Fried Chicken', 'Truffle Mushroom Risotto', 'Mango Sticky Rice', 'Cold Brew Flask'],
        footerText: 'Prices live from the {b} kitchen. Tap any dish to order.',
      },
    },
    {
      title: "Craving-finder quiz for tonight's {b} pick",
      businessGoal: 'Reduce menu paralysis and steer appetite toward a matched high-margin dish',
      trigger: 'inactive 10 days, dinner window',
      moduleId: 'quiz',
      kpi: 'quiz completion to matched-dish order CTR',
      contentPlan: {
        head: 'Answer once, eat well tonight',
        question: 'How hungry are we, honestly?',
        options: [
          { label: 'Light and fresh', result: 'The {b} fresh bowls: fast, bright, and at your door in 30 minutes.' },
          { label: 'Full comfort mode', result: 'The {b} comfort classics: melty, crispy and exactly what today needed.' },
          { label: 'Feeding the table', result: 'The {b} sharing platters: built for the whole squad, priced for one bill.' },
        ],
        footerText: 'Your pick loads straight into the cart.',
      },
    },
    {
      title: 'Rate your last {b} delivery while it is warm',
      businessGoal: 'Capture delivery satisfaction within the hour and intercept bad experiences before churn',
      trigger: '45 minutes after delivery',
      moduleId: 'rating',
      kpi: 'rating submit rate to support-ticket deflection',
      contentPlan: {
        head: 'How was the food, really?',
        prompt: 'One tap, five stars max. Low scores ping the {b} kitchen lead directly.',
        footerText: 'We read every rating before the next service.',
      },
    },
    {
      title: 'Lunch-hour spin: win your {b} side dish',
      businessGoal: 'Create a daily lunchtime open habit with a wheel that always pays out something',
      trigger: 'weekday, 11:30am',
      moduleId: 'spin',
      kpi: 'daily spin rate to lunch order share',
      contentPlan: {
        head: 'Spin before the kitchen gets slammed',
        teaserText: 'Every wedge wins something today: sides, drinks or a discount on the main.',
        footerText: 'Reward auto-applies to your next {b} lunch order.',
      },
    },
    {
      title: 'Menu vote: what should {b} cook up next?',
      businessGoal: 'Crowdsource the next menu item and build launch-day demand from the voters themselves',
      trigger: 'monthly menu-lab campaign',
      moduleId: 'poll',
      kpi: 'vote rate to launch-day orders from voters',
      contentPlan: {
        head: 'The {b} test kitchen needs a verdict',
        question: 'Which dish earns a permanent menu spot?',
        optionA: 'Spicy ramen',
        optionB: 'Loaded fries',
        footerText: 'Voters taste it first at launch.',
      },
    },
    {
      title: 'Household pass calculator: fees vs flat, live in the {b} email',
      businessGoal: 'Move heavy orderers onto the subscription pass by pricing their own month in front of them',
      trigger: 'delivery fees crossed the pass price this month',
      moduleId: 'calc',
      kpi: 'calculator taps to pass activations',
      contentPlan: {
        head: 'Your delivery fees vs the {b} pass',
        promptText: 'Tap your orders per month and who is ordering — the savings number moves as you do.',
        ctaLabel: 'Start the pass',
        footerText: 'Fee estimates use your last 10 orders. Payment happens in the app, never in email.',
      },
    },
    {
      title: 'Your month on {b}: a personal dining report',
      businessGoal: 'Turn order history into a retention story that upsells the pass and lighter menus',
      trigger: 'first week of the month',
      moduleId: 'report',
      kpi: 'report engagement to next-week order rate',
      contentPlan: {
        head: 'Nine orders, one story — your {b} June',
        verdictText: 'Late-night fees are quietly adding up — the pass would have covered them.',
        footerText: 'A summary of your own orders, composed when you opened this email.',
      },
    },
  ],
  Finance: [
    {
      title: 'Fee-waiver reveal for dormant {b} accounts',
      businessGoal: 'Reactivate dormant accounts by unlocking a limited fee waiver on the first trade back',
      trigger: 'dormant 60 days',
      moduleId: 'reveal',
      kpi: 'code copy rate to reactivated accounts',
      contentPlan: {
        head: 'Your {b} account left something behind',
        teaserText: 'A welcome-back waiver is sitting in this email. One tap to see what your comeback earns.',
        ctaLabel: 'Reveal my waiver',
        footerText: 'Waiver applies to your first order after reactivation.',
      },
    },
    {
      title: 'Browse {b} investment products inside the email',
      businessGoal: 'Increase product discovery by letting investors filter invest, save and insure options in-inbox',
      trigger: 'monthly portfolio digest',
      moduleId: 'search',
      kpi: 'filter interactions to product page visits',
      contentPlan: {
        head: 'Every {b} product, one searchable shelf',
        itemNames: ['Index Fund Starter Plan', 'Digital Gold (per gram)', 'Tax-Saver ELSS Bundle', 'Fixed Deposit Booster', 'Micro-SIP Auto Invest', 'Liquid Fund Wallet'],
        footerText: 'Rates and NAVs refresh when you open the app.',
      },
    },
    {
      title: 'Risk-profile quiz: matched fund for {b}',
      businessGoal: 'Move new signups from browsing to a first SIP by matching a fund to their risk appetite',
      trigger: 'onboarding day 3',
      moduleId: 'quiz',
      kpi: 'quiz completion to fund page CTR',
      contentPlan: {
        head: 'Sixty seconds to your starter fund',
        question: 'What is your money mission this year?',
        options: [
          { label: 'Grow it, steadily', result: 'The {b} index-fund starter plan: broad market, low fees, autopilot growth.' },
          { label: 'Chase higher returns', result: 'The {b} equity baskets: higher risk, higher ceiling, eyes-open investing.' },
          { label: 'Protect what I have', result: 'The {b} liquid and FD boosters: money that stays safe, liquid and earning.' },
        ],
        footerText: 'Match is based on your answer, not investment advice.',
      },
    },
    {
      title: 'Post-KYC NPS pulse for {b}',
      businessGoal: 'Measure onboarding friction right after KYC approval, while the memory is freshest',
      trigger: 'KYC approved, day 1',
      moduleId: 'rating',
      kpi: 'NPS response rate to onboarding fixes shipped',
      contentPlan: {
        head: 'Two seconds on your {b} onboarding',
        prompt: 'How likely are you to recommend {b} after setting up your account?',
        footerText: 'Scores below 4 get a call from a human, not a bot.',
      },
    },
    {
      title: 'Spin for a brokerage-free trade day with {b}',
      businessGoal: 'Gamify the first trade of the quarter with a guaranteed-win wheel of trading perks',
      trigger: 'quarter start, active traders',
      moduleId: 'spin',
      kpi: 'spin rate to first-trade-of-quarter rate',
      contentPlan: {
        head: 'Start the quarter with a free spin',
        teaserText: 'Every wedge pays: zero-brokerage days, SIP top-ups or digital gold grams.',
        footerText: 'Perk credits to your {b} account within 24 hours.',
      },
    },
    {
      title: 'Roadmap vote: what should {b} build next?',
      businessGoal: 'Involve power users in roadmap calls and warm them up for the feature launch',
      trigger: 'quarterly product update',
      moduleId: 'poll',
      kpi: 'vote rate to beta waitlist joins',
      contentPlan: {
        head: 'You steer the {b} roadmap today',
        question: 'Which upgrade matters more to you?',
        optionA: 'Lower fees',
        optionB: 'Better insights',
        footerText: 'Voters get first access to the winner.',
      },
    },
    {
      title: 'SIP calculator that answers inside the {b} inbox',
      businessGoal: 'Convert curiosity into a first SIP by letting prospects run their own corpus maths at open',
      trigger: 'onboarding day 5, no first investment yet',
      moduleId: 'calc',
      kpi: 'calculator interactions to first SIP setup',
      contentPlan: {
        head: 'What could a monthly habit become?',
        promptText: 'Tap an amount and a horizon — corpus, amount invested and growth, all worked out in front of you.',
        ctaLabel: 'Set up this SIP',
        assumptionText: 'Assumes 12% p.a. compounded monthly. An illustration, not a promise of returns.',
        footerText: 'Mutual fund investments are subject to market risks. Approval happens in the {b} app.',
      },
    },
    {
      title: 'Monthly {b} statement that explains itself',
      businessGoal: 'Replace the PDF-attachment statement with an in-inbox review that routes to advisory',
      trigger: 'monthly statement day',
      moduleId: 'report',
      kpi: 'row expansions to advisor bookings',
      contentPlan: {
        head: 'Your June statement, decoded',
        ctaLabel: 'Confirm',
        footerText: 'This summary is informational, not investment advice.',
      },
    },
  ],
  Beauty: [
    {
      title: 'Diwali offer reveal for {b} loyalists',
      businessGoal: 'Reward the loyalty tier with a festive-exclusive code before the public Diwali sale opens',
      trigger: 'festive campaign',
      moduleId: 'reveal',
      kpi: 'code copy rate',
      contentPlan: {
        head: 'Your Diwali gift from {b} is inside',
        teaserText: 'Loyalists open the festive vault first. Tap to reveal the code we wrapped for you.',
        ctaLabel: 'Open my gift',
        footerText: 'Festive code valid till Diwali night for {b} members.',
      },
    },
    {
      title: 'Shade-finder shelf: browse {b} bestsellers in-inbox',
      businessGoal: 'Cut bounce by letting shoppers filter skincare, makeup and tools without leaving the email',
      trigger: 'weekly bestsellers digest',
      moduleId: 'search',
      kpi: 'filter taps to PDP visits',
      contentPlan: {
        head: 'The {b} bestseller shelf, searchable',
        itemNames: ['Vitamin C Glow Serum', 'Matte Liquid Lipstick', 'Hydra-Plump Moisturiser', 'Satin Foundation Stick', 'Rosewater Setting Mist', 'Overnight Repair Mask'],
        footerText: 'Stock and shades update live at checkout.',
      },
    },
    {
      title: 'Skin-goal quiz: a personalised {b} routine',
      businessGoal: 'Collect skin-type data and route each subscriber to a matched routine bundle',
      trigger: 'welcome journey, day 2',
      moduleId: 'quiz',
      kpi: 'quiz completion to routine bundle CTR',
      contentPlan: {
        head: 'Your skin has one question to answer',
        question: 'What does your skin want most right now?',
        options: [
          { label: 'Glow and brightness', result: 'The {b} vitamin C duo: serum plus mist for a lit-from-within finish.' },
          { label: 'Deep hydration', result: 'The {b} hydration heroes: moisturiser and overnight mask, thirst solved.' },
          { label: 'Bold colour payoff', result: 'The {b} colour studio: long-wear lips and a foundation that stays put.' },
        ],
        footerText: 'Routine picks refresh as the seasons change.',
      },
    },
    {
      title: 'Two-week check-in: is the {b} serum working?',
      businessGoal: 'Capture efficacy feedback at the moment results show and harvest review content',
      trigger: '14 days after delivery',
      moduleId: 'rating',
      kpi: 'rating submit rate to published reviews',
      contentPlan: {
        head: 'Fourteen days in. Verdict?',
        prompt: 'Rate your {b} purchase now that it has had two weeks on your shelf.',
        footerText: 'High scores unlock a review invite with points attached.',
      },
    },
    {
      title: 'Birthday-month glam spin from {b}',
      businessGoal: 'Make the birthday touchpoint a ritual with a guaranteed beauty reward',
      trigger: 'birthday month, day 1',
      moduleId: 'spin',
      kpi: 'spin rate to birthday order conversion',
      contentPlan: {
        head: 'Birthday week gets the first spin',
        teaserText: 'Minis, discounts or a full-size surprise. The wheel decides, you win either way.',
        footerText: 'Birthday reward valid all month at {b}.',
      },
    },
    {
      title: 'Shade-range vote for the next {b} launch',
      businessGoal: 'De-risk the next shade launch by letting the audience choose the range extension',
      trigger: 'pre-launch teaser campaign',
      moduleId: 'poll',
      kpi: 'vote rate to launch waitlist signups',
      contentPlan: {
        head: 'Help pick the next {b} shades',
        question: 'Which range should we extend first?',
        optionA: 'Warm tones',
        optionB: 'Cool tones',
        footerText: 'Voters get early access to the winning range.',
      },
    },
    {
      title: 'Membership maths: salon-at-home vs pay-per-visit',
      businessGoal: 'Upsell the at-home membership by pricing each subscriber-household against pay-per-visit',
      trigger: 'second full-price session booked',
      moduleId: 'calc',
      kpi: 'calculator taps to membership holds',
      contentPlan: {
        head: 'Two sessions a month? Do the maths',
        promptText: 'Tap how often you book and who shares the visits — the monthly saving updates as you go.',
        ctaLabel: 'Hold my membership',
        footerText: 'Session prices are your city average. Payment stays in the {b} app, never in email.',
      },
    },
    {
      title: 'Refill radar: a routine check-in from {b}',
      businessGoal: 'Time replenishment to actual usage so refill revenue arrives before the product runs out',
      trigger: 'predicted run-out inside 14 days',
      moduleId: 'report',
      kpi: 'check-in opens to refill orders',
      contentPlan: {
        head: 'Two of your dailies are running low',
        verdictText: 'Two dailies are about to run out — a refill now beats a gap week.',
        ctaLabel: 'Queue it',
        footerText: 'Levels estimated from your routine log. Informational, not dermatological advice.',
      },
    },
  ],
  Electronics: [
    {
      title: 'Upgrade-week reveal: trade-in bonus for {b} owners',
      businessGoal: 'Pull upgrade-cycle customers back with a reveal-gated bonus on top of trade-in value',
      trigger: '18 months after last device purchase',
      moduleId: 'reveal',
      kpi: 'code copy rate to trade-in bookings',
      contentPlan: {
        head: 'Your {b} upgrade bonus is unlocked',
        teaserText: "Your current device has trade-in value. Tap to reveal this week's bonus on top of it.",
        ctaLabel: 'Reveal trade-in bonus',
        footerText: 'Bonus applies over standard {b} trade-in value.',
      },
    },
    {
      title: 'Gadget-finder grid: browse {b} gear in the email',
      businessGoal: 'Surface the full accessory range to buyers who only know the hero product',
      trigger: '7 days after device purchase',
      moduleId: 'search',
      kpi: 'filter interactions to accessory attach rate',
      contentPlan: {
        head: 'Gear that pairs with your new {b}',
        itemNames: ['Noise-Cancelling Earbuds', 'Smartwatch Series X', 'Fast-Charge Power Bank', 'Portable SSD 1TB', 'Mechanical Keyboard', '4K Action Camera'],
        footerText: 'Bundle pricing shows at checkout.',
      },
    },
    {
      title: 'Setup-match quiz: find your next {b} upgrade',
      businessGoal: 'Qualify upgrade intent and route each answer to the right category page',
      trigger: 'browse abandon, 24 hours',
      moduleId: 'quiz',
      kpi: 'quiz completion to category page CTR',
      contentPlan: {
        head: 'What is your setup missing?',
        question: 'Which upgrade would change your day the most?',
        options: [
          { label: 'Better sound', result: 'The {b} audio line: noise-cancelling earbuds that erase the commute.' },
          { label: 'Smarter tracking', result: 'The {b} wearables: sleep, steps and stress, quantified on your wrist.' },
          { label: 'Faster workflow', result: 'The {b} pro accessories: mechanical keys and a terabyte in your pocket.' },
        ],
        footerText: 'Answers tune your next recommendations.',
      },
    },
    {
      title: 'Day-30 owner review of your {b} gadget',
      businessGoal: 'Harvest verified-owner ratings at day 30 to power product-page social proof',
      trigger: '30 days after delivery',
      moduleId: 'rating',
      kpi: 'rating submit rate to PDP review volume',
      contentPlan: {
        head: 'One month with your {b} gadget',
        prompt: 'Rate your device now the honeymoon is over. Owners trust day-30 reviews most.',
        footerText: 'Verified ratings appear on the product page.',
      },
    },
    {
      title: 'Flash-sale spin: warranty and accessory perks from {b}',
      businessGoal: 'Add a gamified layer to the flash sale that pays out margin-friendly perks',
      trigger: 'flash sale open, hour 1',
      moduleId: 'spin',
      kpi: 'spin rate to flash-sale AOV',
      contentPlan: {
        head: 'Spin before the flash-sale timer dies',
        teaserText: 'Extended warranty, accessory vouchers or extra percent off. Every wedge lands.',
        footerText: 'Perk stacks with {b} flash-sale pricing.',
      },
    },
    {
      title: 'Launch vote: which {b} product ships next?',
      businessGoal: 'Read demand between two candidate launches and prime the voters for pre-order',
      trigger: 'pre-launch hype campaign',
      moduleId: 'poll',
      kpi: 'vote rate to pre-order signups',
      contentPlan: {
        head: 'Two prototypes. One {b} launch slot.',
        question: 'Which one should hit the shelf first?',
        optionA: 'Foldable phone',
        optionB: 'AR glasses',
        footerText: 'Voters get pre-order priority for the winner.',
      },
    },
    {
      title: 'Cart EMI calculator: the monthly cost at a tap',
      businessGoal: 'Unstick high-ticket carts by showing the affordable monthly number instead of the sticker price',
      trigger: 'high-value cart idle 4 hours',
      moduleId: 'calc',
      kpi: 'EMI interactions to checkout completions',
      contentPlan: {
        head: 'That cart, in monthly instalments',
        promptText: 'Tap a cart value and a tenure — the EMI and total interest recalculate in front of you.',
        ctaLabel: 'Lock this EMI plan',
        assumptionText: 'Illustration at 15% p.a. — your card issuer sets the final rate at checkout.',
        footerText: 'Price lock holds 48 hours. Nothing is charged inside this email.',
      },
    },
    {
      title: 'Device health report with a warranty nudge',
      businessGoal: 'Monetise the installed base with warranty renewals timed to a genuinely useful device check',
      trigger: 'warranty expiring in 14 days',
      moduleId: 'report',
      kpi: 'report opens to warranty renewals',
      contentPlan: {
        head: 'Your {b} devices, checked at open',
        verdictText: 'A warranty and a backup are the two things worth doing this week.',
        ctaLabel: 'Lock it',
        footerText: 'Device data comes from your linked {b} account, read at open.',
      },
    },
  ],
  Travel: [
    {
      title: 'Fare-drop reveal on your saved {b} route',
      businessGoal: 'Convert watchers into bookers the moment a tracked fare actually drops',
      trigger: 'price drop on a saved route',
      moduleId: 'reveal',
      kpi: 'code copy rate to booking starts',
      contentPlan: {
        head: 'The fare you watch just dropped',
        teaserText: 'Your saved route moved. Tap to reveal the new fare and a code that sweetens it.',
        ctaLabel: 'Show the new fare',
        footerText: 'Fares move fast. Code holds for 24 hours on {b}.',
      },
    },
    {
      title: 'Weekend-escape browser inside the {b} email',
      businessGoal: 'Sell short-notice inventory by letting travellers filter beach, mountain and city breaks in-inbox',
      trigger: 'Wednesday weekend-planning window',
      moduleId: 'search',
      kpi: 'filter taps to itinerary page visits',
      contentPlan: {
        head: 'This weekend, somewhere new',
        itemNames: ['Goa Beach Escape (3N)', 'Weekend City Break', 'Himalayan Trek Package', 'Bali Honeymoon (5N)', 'Airport Lounge Pass', 'Travel Insurance Plus'],
        footerText: 'Live availability checks at booking.',
      },
    },
    {
      title: 'Trip-persona quiz: your matched {b} getaway',
      businessGoal: 'Segment travellers by trip style and pitch the matching package while intent is warm',
      trigger: 'post-search abandon, 48 hours',
      moduleId: 'quiz',
      kpi: 'quiz completion to package page CTR',
      contentPlan: {
        head: 'Where is your head at, traveller?',
        question: 'Pick the postcard you would actually send.',
        options: [
          { label: 'Toes in the sand', result: 'The {b} beach escapes: three nights, sea view, zero alarms.' },
          { label: 'Peaks and trails', result: 'The {b} mountain treks: guided routes, big air, bigger views.' },
          { label: 'City lights', result: 'The {b} city breaks: flights plus stay, weekend-sized and ready.' },
        ],
        footerText: 'Your pick tunes the deals we send.',
      },
    },
    {
      title: 'Welcome-home rating for your {b} trip',
      businessGoal: 'Capture trip satisfaction on landing day and source testimonial content',
      trigger: 'day after the return flight',
      moduleId: 'rating',
      kpi: 'rating submit rate to testimonial pipeline',
      contentPlan: {
        head: 'Back home. How was it?',
        prompt: 'Rate the trip you booked with {b}, from airport to checkout.',
        footerText: 'Great trips become featured stories, with your OK.',
      },
    },
    {
      title: 'Long-weekend spin: win a {b} travel perk',
      businessGoal: 'Ride long-weekend planning spikes with a wheel of upgrade perks',
      trigger: '3 weeks before a long weekend',
      moduleId: 'spin',
      kpi: 'spin rate to long-weekend bookings',
      contentPlan: {
        head: 'A long weekend is coming. Spin first.',
        teaserText: 'Lounge passes, seat upgrades or straight discounts. The wheel always pays.',
        footerText: 'Perk applies to bookings made this week on {b}.',
      },
    },
    {
      title: 'Destination duel: pick the next {b} deal drop',
      businessGoal: 'Let demand pick the next negotiated deal destination and build a warm list for it',
      trigger: 'monthly deal-drop teaser',
      moduleId: 'poll',
      kpi: 'vote rate to deal-drop opens',
      contentPlan: {
        head: 'Two destinations. One {b} mega-deal.',
        question: 'Where should we unlock the next big deal?',
        optionA: 'Japan',
        optionB: 'Iceland',
        footerText: 'The winning destination drops to voters first.',
      },
    },
    {
      title: 'Trip EMI estimator: travel now, spread the cost',
      businessGoal: 'Convert wishlist trips into bookings by turning the scary total into a monthly number',
      trigger: 'saved trip viewed 3 times without booking',
      moduleId: 'calc',
      kpi: 'EMI interactions to eligibility checks',
      contentPlan: {
        head: 'Bali, but make it monthly',
        promptText: 'Tap a trip budget and a tenure — the monthly number and total interest update live.',
        ctaLabel: 'Check my eligibility',
        footerText: 'The lender sets the final rate after eligibility. Nothing is charged inside this email.',
      },
    },
    {
      title: 'Trip readiness report: loose ends at a glance',
      businessGoal: 'Attach insurance, check-in and transfers to the booking by surfacing them as live to-dos',
      trigger: '7 days before departure',
      moduleId: 'report',
      kpi: 'readiness opens to ancillary attach rate',
      contentPlan: {
        head: 'Your Goa trip: two loose ends left',
        verdictText: 'Check-in and monsoon cover are the two loose ends before you fly.',
        ctaLabel: 'Set it up',
        footerText: 'Booking status is read live from your {b} trip at open.',
      },
    },
  ],
  Generic: [
    {
      title: 'Win-back offer reveal for lapsed {b} users',
      businessGoal: 'Reactivate 60-day dormant users with a curiosity-gap reveal instead of a flat discount blast',
      trigger: 'dormant 60 days',
      moduleId: 'reveal',
      kpi: 'code copy rate to reactivation rate',
      contentPlan: {
        head: 'We saved something for you at {b}',
        teaserText: 'It has been a while. Tap to reveal what your comeback unlocks.',
        ctaLabel: 'Reveal my offer',
        footerText: 'Offer reserved for returning {b} customers.',
      },
    },
    {
      title: 'Plan-picker: compare {b} plans inside the email',
      businessGoal: 'Shorten the upgrade decision by making plans browsable and filterable in-inbox',
      trigger: 'trial day 10 of 14',
      moduleId: 'search',
      kpi: 'filter interactions to upgrade page visits',
      contentPlan: {
        head: 'Find the {b} plan that fits',
        itemNames: ['Starter Plan', 'Pro Plan', 'Team Bundle', 'Annual Saver', 'Add-on Pack', 'Premium Support'],
        footerText: 'Prices shown are current. Upgrades apply instantly.',
      },
    },
    {
      title: 'Best-plan quiz for new {b} signups',
      businessGoal: 'Route each new signup to the right plan tier with one qualifying question',
      trigger: 'onboarding day 3',
      moduleId: 'quiz',
      kpi: 'quiz completion to plan page CTR',
      contentPlan: {
        head: 'One question, best {b} plan',
        question: 'What brings you to {b} right now?',
        options: [
          { label: 'Just exploring', result: 'Start on the {b} free tour: all the highlights, zero commitment.' },
          { label: 'Ready to commit', result: 'The {b} Pro plan unlocks everything you signed up to do.' },
          { label: 'Scaling a team', result: 'The {b} team bundle: seats, tools and support that grow with you.' },
        ],
        footerText: 'Your answer shapes your onboarding emails.',
      },
    },
    {
      title: 'Day-30 NPS pulse for {b}',
      businessGoal: 'Benchmark satisfaction at the 30-day mark and trigger save-plays on low scores',
      trigger: 'day 30 after signup',
      moduleId: 'rating',
      kpi: 'NPS response rate to detractor save rate',
      contentPlan: {
        head: 'Thirty days with {b}. Score us.',
        prompt: 'How likely are you to recommend {b} to a colleague or friend?',
        footerText: 'Low scores route to a human within a day.',
      },
    },
    {
      title: 'Milestone spin: celebrate a year with {b}',
      businessGoal: 'Turn the anniversary email into a reward moment that renews before the renewal ask',
      trigger: 'signup anniversary',
      moduleId: 'spin',
      kpi: 'spin rate to renewal conversion',
      contentPlan: {
        head: 'One year with {b}. You spin first.',
        teaserText: 'Anniversary wheel: discounts, add-on credits or a free month. Every wedge wins.',
        footerText: 'Anniversary reward applies to your next {b} bill.',
      },
    },
    {
      title: 'Roadmap vote: what should {b} ship next?',
      businessGoal: 'Give engaged users a say in the roadmap and seed the launch-day audience',
      trigger: 'quarterly product newsletter',
      moduleId: 'poll',
      kpi: 'vote rate to feature launch opens',
      contentPlan: {
        head: 'You get a vote at {b} today',
        question: 'Which should the team ship first?',
        optionA: 'Mobile app',
        optionB: 'Integrations',
        footerText: 'Voters hear about the winner first.',
      },
    },
    {
      title: 'Cart-rescue reveal: your {b} checkout nudge',
      businessGoal: 'Recover abandoned carts with a reveal-gated incentive that feels earned, not begged',
      trigger: 'cart abandoned 4 hours',
      moduleId: 'reveal',
      kpi: 'code copy rate to recovered checkouts',
      contentPlan: {
        head: 'Your {b} cart is holding a secret',
        teaserText: 'Everything you picked is still here, plus one thing you have not seen yet. Tap it.',
        ctaLabel: 'Finish my order',
        footerText: 'Cart held for 48 hours. Code is single-use.',
      },
    },
    {
      title: 'Support CSAT: rate your last {b} ticket',
      businessGoal: 'Measure support quality per ticket without a survey portal login',
      trigger: 'ticket closed, 2 hours',
      moduleId: 'rating',
      kpi: 'CSAT response rate to reopened-ticket rate',
      contentPlan: {
        head: 'Did we actually fix it?',
        prompt: 'Rate the support you just got from {b}. One tap, straight to the team lead.',
        footerText: 'Ratings tie back to the exact ticket.',
      },
    },
    {
      title: 'Pro-plan savings calculator for {b} workspaces',
      businessGoal: 'Upgrade metered workspaces by letting the admin price flat Pro against their own usage',
      trigger: 'metered spend exceeded Pro price this month',
      moduleId: 'calc',
      kpi: 'calculator interactions to upgrade conversations',
      contentPlan: {
        head: 'Your usage vs the flat {b} Pro plan',
        promptText: 'Tap your team size and monthly usage — pay-as-you-go versus flat Pro, worked out live.',
        ctaLabel: 'Talk to us about Pro',
        footerText: 'Estimates use last month of metered usage. Nothing is ever charged inside this email.',
      },
    },
    {
      title: 'Account health summary ahead of renewal day',
      businessGoal: 'Protect renewals by surfacing billing and usage risks two weeks before the charge',
      trigger: '14 days before renewal',
      moduleId: 'report',
      kpi: 'summary opens to involuntary-churn saves',
      contentPlan: {
        head: 'Your {b} workspace, checked at open',
        verdictText: 'Billing and storage are the two things to touch before renewal day.',
        ctaLabel: 'Confirm',
        footerText: 'Workspace numbers are read at open. Informational, not a bill.',
      },
    },
  ],
};

// If a module is ever renamed/removed in generate.js, fail loudly at load
// time instead of silently proposing use-cases for a module that no longer
// exists (same guard as brief-router's KEYWORD_MAP).
for (const [vertical, entries] of Object.entries(USECASE_LIBRARY)) {
  for (const entry of entries) {
    if (!MODULE_IDS.includes(entry.moduleId)) {
      throw new Error(`usecase-engine: ${vertical} entry "${entry.title}" names unknown module "${entry.moduleId}"`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * validateUseCase — the local allowlist every use-case must survive
 * ------------------------------------------------------------------ */

// A single plain-text field: trimmed, 1..maxLen, and free of '<'/'>' (a
// model going off the rails and writing markup, which must never reach any
// template or share page). Same contract as brief-content's field validator.
function cleanString(val, maxLen) {
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  if (!trimmed || trimmed.length > maxLen) return null;
  if (/[<>]/.test(trimmed)) return null;
  return trimmed;
}

// Allowlist re-validation of one use-case (LLM output or library entry).
// Fatal (-> null): not an object, missing/invalid title, unknown moduleId,
// or any PRESENT descriptor string that is non-string/empty/over-cap/markup.
// Not fatal: unknown fields (stripped) and a contentPlan that fails
// validatePlan (degrades to {} — a use-case without copy overrides still
// pitches; the plan is optional garnish, the idea is the product).
function validateUseCase(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.moduleId !== 'string' || !MODULE_IDS.includes(obj.moduleId)) return null;
  const title = cleanString(obj.title, CAPS.title);
  if (title === null) return null;

  const out = { title, moduleId: obj.moduleId };
  for (const key of ['businessGoal', 'trigger', 'kpi']) {
    if (obj[key] === undefined) continue; // absent is fine; present must be clean
    const s = cleanString(obj[key], CAPS[key]);
    if (s === null) return null;
    out[key] = s;
  }

  let plan = {};
  if (obj.contentPlan && typeof obj.contentPlan === 'object' && !Array.isArray(obj.contentPlan)) {
    plan = validatePlan(obj.moduleId, obj.contentPlan) || {};
  }
  out.contentPlan = plan;
  return out;
}

/* ------------------------------------------------------------------ *
 * brand interpolation
 * ------------------------------------------------------------------ */

// The brand name is interpolated into already-validated strings, so it must
// itself honour the no-markup rule; a pathological name degrades to the
// house default rather than poisoning every use-case it touches.
function safeBrand(name) {
  const b = String(name || '').replace(/[<>]/g, '').trim();
  return b || 'Acme';
}

// '{b}' tokens survive validation (they are plain text) and are interpolated
// last, so library entries and any LLM output that echoes the token both
// land fully branded. Descriptor fields are re-capped after interpolation (a
// long brand can push a boundary-length string over its cap); the
// contentPlan is re-run through validatePlan instead — a plan the
// interpolation breaks degrades to {}, never to an oversized field.
function brandUseCase(uc, brand) {
  const plan = {};
  for (const [key, val] of Object.entries(uc.contentPlan || {})) {
    if (typeof val === 'string') {
      plan[key] = applyBrand(val, brand);
    } else if (Array.isArray(val)) {
      plan[key] = val.map((item) => (typeof item === 'string'
        ? applyBrand(item, brand)
        : {
          label: applyBrand(item.label, brand),
          ...(item.result !== undefined ? { result: applyBrand(item.result, brand) } : {}),
        }));
    }
  }
  const out = { title: applyBrand(uc.title, brand).slice(0, CAPS.title), moduleId: uc.moduleId };
  for (const key of ['businessGoal', 'trigger', 'kpi']) {
    if (typeof uc[key] === 'string') out[key] = applyBrand(uc[key], brand).slice(0, CAPS[key]);
  }
  out.contentPlan = validatePlan(uc.moduleId, plan) || {};
  return out;
}

/* ------------------------------------------------------------------ *
 * library ordering (zero-key tier + top-ups)
 * ------------------------------------------------------------------ */

// Deterministic ordering: the vertical's own entries lead (extended with
// Generic's so a count above the vertical's list still fills — title-dedupe
// downstream keeps it clean), and when the brief routes to a module that
// module's first use-case is hoisted to the front. It is the concept the
// brief actually asked for, mirroring slate-core's routed-first ordering.
function libraryFor(vertical, briefText) {
  const own = USECASE_LIBRARY[vertical] || USECASE_LIBRARY.Generic;
  const pool = vertical === 'Generic' ? own.slice() : own.concat(USECASE_LIBRARY.Generic);
  const routed = briefText ? routeBrief(briefText) : null;
  if (routed) {
    const i = pool.findIndex((e) => e.moduleId === routed.moduleId);
    if (i > 0) pool.unshift(pool.splice(i, 1)[0]);
  }
  return pool;
}

/* ------------------------------------------------------------------ *
 * prompts + JSON schemas for the LLM tier
 * ------------------------------------------------------------------ */

// What each module can DO, in business terms — the vocabulary the LLM maps
// ideas onto. Field lists come from FIELD_SCHEMAS so the prompt can never
// drift from what validatePlan will actually accept.
const MODULE_POWERS = {
  reveal: 'tap-to-reveal a hidden offer and coupon code',
  search: 'live searchable, filterable item grid inside the email',
  quiz: 'one-question quiz mapping each answer to a tailored recommendation',
  rating: 'one-tap 1-5 star rating captured in the inbox',
  spin: 'spin-the-wheel reward reveal with a guaranteed coupon',
  poll: 'two-option tap poll with an instant result',
  calc: 'tap-driven live calculator (SIP/EMI/plan-savings maths) where preset pills and a stepper move a big precomputed result instantly',
  report: 'personalised report/statement viewer with tap-to-expand status rows, a verdict reveal and a pick-then-confirm next-step CTA',
};

function moduleVocabulary() {
  return MODULE_IDS.map((id) => {
    const schema = FIELD_SCHEMAS[id] || {};
    const fields = Object.keys(schema).map((key) => {
      const def = schema[key];
      if (def.type === 'stringArray') return `${key} (up to ${def.maxItems} short item names)`;
      if (def.type === 'quizOptions') return `${key} (exactly ${def.count} of {label, result})`;
      return key;
    }).join(', ');
    return `- ${id} ("${MODULES[id].name}"): ${MODULE_POWERS[id]}. contentPlan fields: ${fields}`;
  }).join('\n');
}

// Dossier values are whatever the dossier builder produced (or a caller
// hand-rolled), so every field is treated as optional and untrusted-shaped;
// only well-formed pieces make it into the prompt.
function asStringList(value, cap) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value) {
    let s = '';
    if (typeof v === 'string') s = v;
    else if (v && typeof v === 'object') s = (typeof v.name === 'string' && v.name) || (typeof v.title === 'string' && v.title) || '';
    const t = s.trim();
    if (t) out.push(t.slice(0, 80));
    if (out.length >= cap) break;
  }
  return out;
}

function dossierLines(d) {
  const lines = [];
  if (typeof d.name === 'string' && d.name.trim()) lines.push(`Brand: ${d.name.trim()}`);
  if (typeof d.vertical === 'string' && d.vertical.trim()) lines.push(`Vertical: ${d.vertical.trim()}`);
  if (typeof d.summary === 'string' && d.summary.trim()) lines.push(`Summary: ${d.summary.trim().slice(0, 600)}`);
  const products = asStringList(d.products, 8);
  if (products.length) lines.push(`Products: ${products.join(', ')}`);
  if (typeof d.voice === 'string' && d.voice.trim()) lines.push(`Voice: ${d.voice.trim().slice(0, 200)}`);
  const campaigns = asStringList(d.campaigns, 5);
  if (campaigns.length) lines.push(`Recent campaigns: ${campaigns.join('; ')}`);
  return lines.length ? lines.join('\n') : 'No dossier available - propose from the vertical and brief alone.';
}

// One JSON schema serves every provider: the use-case envelope with a
// contentPlan that unions every module's field schema (Object.assign is
// last-wins, which happens to keep the loosest variant on collisions like
// itemNames), because one request mixes modules and per-item conditional
// schemas are not portable across providers. The prompt pins each plan to
// its own module's fields; validateUseCase + validatePlan enforce it locally
// regardless of what the model actually does.
function planUnionSchema() {
  const properties = {};
  for (const id of MODULE_IDS) {
    const moduleSchema = schemaFor(id);
    if (moduleSchema) Object.assign(properties, moduleSchema.properties);
  }
  return { type: 'object', properties, additionalProperties: false };
}

function useCaseSchema() {
  return {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: CAPS.title },
      businessGoal: { type: 'string', maxLength: CAPS.businessGoal },
      trigger: { type: 'string', maxLength: CAPS.trigger },
      moduleId: { type: 'string', enum: MODULE_IDS.slice() },
      kpi: { type: 'string', maxLength: CAPS.kpi },
      contentPlan: planUnionSchema(),
    },
    required: ['title', 'moduleId'],
    additionalProperties: false,
  };
}

// The array is wrapped in an object envelope: several json-mode providers
// mishandle a bare top-level array (Groq's json_object mode outright
// requires an object), and the local parser accepts either shape anyway.
function proposeSchema(count) {
  return {
    type: 'object',
    properties: {
      useCases: { type: 'array', minItems: 1, maxItems: count, items: useCaseSchema() },
    },
    required: ['useCases'],
    additionalProperties: false,
  };
}

function buildProposePrompt({
  brand, vertical, dossier, briefText, count, feedback, priorTitles,
}) {
  const lines = [
    `You are a lifecycle-marketing strategist for the brand "${brand}"${vertical ? ` (${vertical} vertical)` : ''}. Propose ${count} interactive AMP email use-cases: real revenue and retention plays a CRM team would actually ship, each mapped to exactly one interaction module below.`,
    '',
    'Brand dossier (context only, never quote it verbatim):',
    dossierLines(dossier),
    '',
  ];
  if (briefText) {
    lines.push('Campaign brief:', '"""', briefText.slice(0, 600), '"""', '');
  }
  lines.push('Available interaction modules:', moduleVocabulary(), '');
  if (feedback) {
    lines.push(`Steering feedback from the team: "${feedback}". Let it reshape what you propose.`, '');
  }
  if (priorTitles.length) {
    lines.push(
      'Use-cases already proposed earlier — REPLACE or IMPROVE these according to the feedback, do not repeat them:',
      priorTitles.map((t) => `- ${t}`).join('\n'),
      '',
    );
  }
  lines.push(`Return JSON: { "useCases": [ ... ] } with ${count} items. Each item: title (specific to this business, max 80 chars), businessGoal (the commercial outcome, max 160), trigger (the lifecycle moment that sends the email, max 80), moduleId (one of: ${MODULE_IDS.join(', ')}), kpi (the metric pair to watch, max 80), contentPlan (optional copy overrides using ONLY the chosen module's fields listed above). Plain text everywhere: no HTML, no markdown, no links, never the characters < or >. Modules MAY repeat across use-cases when the underlying business ideas differ.`);
  return lines.join('\n');
}

function buildShapePrompt({ brand, dossier, idea }) {
  return [
    `A teammate pitched this AMP email idea for the brand "${brand}". Shape THIS exact idea into a structured use-case — do not replace it with a different idea and do not water it down. Pick the single best-fitting interaction module and keep the teammate's intent recognisable in the title.`,
    '',
    'The idea:',
    '"""',
    idea.slice(0, 600),
    '"""',
    '',
    'Brand dossier (context only, never quote it verbatim):',
    dossierLines(dossier),
    '',
    'Available interaction modules:',
    moduleVocabulary(),
    '',
    `Return ONE JSON object: title (max 80 chars, faithful to the idea), businessGoal (max 160), trigger (the lifecycle moment, max 80), moduleId (one of: ${MODULE_IDS.join(', ')}), kpi (max 80), contentPlan (optional copy overrides using ONLY the chosen module's fields listed above). Plain text everywhere: no HTML, no markdown, no links, never the characters < or >.`,
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * providers
 * ------------------------------------------------------------------ */

// Environment auto-detection mirrors brief-content's defaultProviders, but
// use-case drafting asks only the FIRST configured provider (order below is
// preference order) — one richer call, and any failure degrades straight to
// the library tier rather than trying the next key.
function defaultProviders() {
  const providers = [];
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic();
      providers.push((prompt, schema, timeoutMs) => callClaude({
        client, model: CLAUDE_MODEL, prompt, schema, timeoutMs,
      }));
    } catch (e) {
      console.error('[usecase-engine] failed to construct Anthropic client:', e && e.message);
    }
  }
  if (process.env.GEMINI_API_KEY) {
    providers.push((prompt, schema, timeoutMs) => callGemini({
      apiKey: process.env.GEMINI_API_KEY, model: GEMINI_MODEL, prompt, schema, timeoutMs,
    }));
  }
  if (process.env.GROQ_API_KEY) {
    providers.push((prompt, schema, timeoutMs) => callGroq({
      apiKey: process.env.GROQ_API_KEY, model: GROQ_MODEL, prompt, schema, timeoutMs,
    }));
  }
  if (OLLAMA_BASE_URL) {
    providers.push((prompt, schema, timeoutMs) => callOllama({
      baseUrl: OLLAMA_BASE_URL, model: OLLAMA_MODEL, prompt, schema, timeoutMs,
    }));
  }
  return providers;
}

// Single-provider call with the same never-throw / never-hang contract as
// composeContent: a sync throw is folded into the promise, the budget is
// raced here as defense in depth even though the built-in providers time
// themselves out, and a string body (Gemini/Groq/Ollama-style) is parsed.
// Accepts a bare thunk (prompt, schema, timeoutMs) or a brief-content-style
// { name, call } descriptor, so either provider convention can be injected.
async function callFirstProvider(providers, prompt, schema, timeoutMs) {
  const first = providers[0];
  const call = typeof first === 'function'
    ? first
    : (first && typeof first.call === 'function' ? first.call.bind(first) : null);
  if (!call) return null;
  try {
    const raw = await withTimeout(() => Promise.resolve().then(() => call(prompt, schema, timeoutMs)), timeoutMs);
    if (raw == null) return null;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch (e) { return null; }
    }
    return typeof raw === 'object' ? raw : null;
  } catch (e) {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * proposeUseCases / shapeUserIdea
 * ------------------------------------------------------------------ */

// count is untrusted client input: whole number, clamped 1..8, defaulting to
// 6 (one idea per module is the natural pitch-slate size).
function clampCount(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 6;
  return Math.max(1, Math.min(8, v));
}

// input: { dossier, brief, count, feedback, prior } — dossier is the brand
// dossier ({ name, vertical, summary, products, voice, campaigns }, all
// optional), brief the free-text campaign brief, feedback a steering note
// from the team, prior earlier use-cases (or their titles) the LLM should
// replace/improve rather than repeat. In the zero-key tier feedback/prior
// are accepted but deterministically ignored — the library has no dial to
// turn, and erroring on them would punish the caller for a missing API key.
// opts: { providers (DI array of provider thunks), timeoutMs (tests only) }.
// Returns { useCases: [{ id, title, businessGoal, trigger, moduleId, kpi,
// contentPlan }], source: 'llm' | 'library' } and NEVER throws.
async function proposeUseCases(input = {}, opts = {}) {
  const args = (input && typeof input === 'object') ? input : {};
  const dossier = (args.dossier && typeof args.dossier === 'object') ? args.dossier : {};
  const brand = safeBrand(dossier.name);
  const vertical = VERTICALS.includes(dossier.vertical) ? dossier.vertical : 'Generic';
  const count = clampCount(args.count);
  const briefText = typeof args.brief === 'string' ? args.brief.trim() : '';
  const feedback = typeof args.feedback === 'string' ? args.feedback.trim().slice(0, 600) : '';
  const priorTitles = asStringList(args.prior, 12);

  const providers = Array.isArray(opts.providers) ? opts.providers : defaultProviders();
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : TIMEOUT_MS;

  const out = [];
  const seen = new Set(); // lowercased titles, so an LLM item never shadows its library twin
  if (providers.length) {
    const prompt = buildProposePrompt({
      brand, vertical, dossier, briefText, count, feedback, priorTitles,
    });
    const raw = await callFirstProvider(providers, prompt, proposeSchema(count), timeoutMs);
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.useCases) ? raw.useCases : []);
    for (const candidate of list) {
      if (out.length >= count) break;
      let branded = null;
      try {
        const uc = validateUseCase(candidate);
        // Re-validated after interpolation: belt and braces, and it keeps the
        // "everything returned passed validateUseCase" invariant literal.
        branded = uc && validateUseCase(brandUseCase(uc, brand));
      } catch (e) {
        branded = null;
      }
      if (!branded || seen.has(branded.title.toLowerCase())) continue;
      seen.add(branded.title.toLowerCase());
      out.push(branded);
    }
  }
  const source = out.length ? 'llm' : 'library';

  // Shortfall (no keys, provider failure, invalid/short LLM output) tops up
  // from the hand-authored library, routed module first.
  for (const entry of libraryFor(vertical, briefText)) {
    if (out.length >= count) break;
    const branded = validateUseCase(brandUseCase(entry, brand));
    if (!branded || seen.has(branded.title.toLowerCase())) continue;
    seen.add(branded.title.toLowerCase());
    out.push(branded);
  }

  return { useCases: out.map((uc) => ({ id: newId(), ...uc })), source };
}

// input: { idea, dossier } — idea is free text from the team (e.g. "lab
// report opener like Practo"). Returns one use-case in the same shape as
// proposeUseCases' items, or null ONLY for an empty/whitespace idea. The LLM
// tier shapes the idea into the structure; any LLM failure degrades to the
// deterministic shape (routeBrief picks the module, the idea becomes the
// title) — never to null, because the team's idea is always worth keeping.
async function shapeUserIdea(input = {}, opts = {}) {
  const args = (input && typeof input === 'object') ? input : {};
  const idea = typeof args.idea === 'string' ? args.idea.trim() : '';
  if (!idea) return null;
  const dossier = (args.dossier && typeof args.dossier === 'object') ? args.dossier : {};
  const brand = safeBrand(dossier.name);

  const providers = Array.isArray(opts.providers) ? opts.providers : defaultProviders();
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : TIMEOUT_MS;

  if (providers.length) {
    const raw = await callFirstProvider(providers, buildShapePrompt({ brand, dossier, idea }), useCaseSchema(), timeoutMs);
    let branded = null;
    try {
      const uc = raw ? validateUseCase(raw) : null;
      branded = uc && validateUseCase(brandUseCase(uc, brand));
    } catch (e) {
      branded = null;
    }
    if (branded) return { id: newId(), ...branded };
  }

  const routed = routeBrief(idea);
  return {
    id: newId(),
    // The idea itself becomes the title: markup chars stripped (the one rule
    // no string may break), capped at the title budget.
    title: idea.replace(/[<>]/g, '').slice(0, CAPS.title).trim() || 'Team idea',
    moduleId: (routed && routed.moduleId) || 'reveal',
    businessGoal: 'Team-supplied use-case',
    trigger: 'custom',
    kpi: 'engagement',
    contentPlan: {},
  };
}

module.exports = {
  proposeUseCases, shapeUserIdea, validateUseCase, USECASE_LIBRARY,
};
