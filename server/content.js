'use strict';

// Vertical content library. All copy reads as real and brand-plausible.
// The {b} token is interpolated with the brand name at generate time.
// Prices are stored as plain integers; the currency symbol is applied (and
// entity-encoded) by generate.js so the same content works for any currency.

const VERTICALS = ['Fashion', 'Food', 'Finance', 'Beauty', 'Electronics', 'Travel', 'Generic'];

// Tone-driven headline templates. {b} = brand.
const TONES = {
  Playful: {
    reveal: 'Psst {b} has a little something for you',
    quiz: 'Which {b} pick is your vibe?',
    poll: 'Settle it for us, {b} fan',
    rate: 'How did we do? Be honest!',
    spin: 'Feeling lucky? Give it a whirl',
    search: 'Hunt down your next {b} favourite',
  },
  Premium: {
    reveal: 'An exclusive {b} offer, curated for you',
    quiz: 'Discover the {b} edit made for you',
    poll: 'Help shape the next {b} collection',
    rate: 'Your impression of {b} matters',
    spin: 'Unlock a members-only {b} reward',
    search: 'Explore the {b} collection',
  },
  Urgent: {
    reveal: 'Your {b} offer expires tonight open now',
    quiz: 'Find your match before the sale ends',
    poll: 'Last chance to vote {b} drops soon',
    rate: 'Quick rate your last {b} order',
    spin: 'One spin left claim your {b} deal now',
    search: 'Selling fast find yours before it goes',
  },
  Informative: {
    reveal: 'A new offer is available on your {b} account',
    quiz: 'Answer one question for a tailored {b} pick',
    poll: 'Share your preference with the {b} team',
    rate: 'Rate your recent experience with {b}',
    spin: 'Spin to see your available {b} reward',
    search: 'Search the full {b} catalogue',
  },
};

const CONTENT = {
  Fashion: {
    items: [
      { name: 'Linen Resort Shirt', price: 2499 },
      { name: 'High-Rise Tailored Trousers', price: 3299 },
      { name: 'Suede Chelsea Boots', price: 4799 },
      { name: 'Oversized Knit Sweater', price: 2899 },
      { name: 'Pleated Midi Skirt', price: 1999 },
      { name: 'Cropped Denim Jacket', price: 3599 },
    ],
    categories: ['Apparel', 'Footwear', 'Accessories'],
    catKeys: ['apparel', 'footwear', 'accessories'],
    itemCats: ['apparel', 'apparel', 'footwear', 'apparel', 'apparel', 'apparel'],
    quiz: {
      q: 'What is your go-to weekend look?',
      options: [
        { label: 'Effortless & casual', result: 'You will love the {b} relaxed linen edit comfort first, always.' },
        { label: 'Sharp & tailored', result: 'The {b} tailoring line is calling clean lines, smart fits.' },
        { label: 'Bold statement', result: 'Go big with the {b} statement collection colour and texture that turn heads.' },
      ],
    },
    poll: { q: 'Which drop should {b} restock first?', a: 'Suede boots', b: 'Knit sweaters' },
    rate: 'How would you rate your latest {b} order?',
  },
  Food: {
    items: [
      { name: 'Wood-Fired Margherita', price: 399 },
      { name: 'Truffle Mushroom Risotto', price: 549 },
      { name: 'Korean Fried Chicken Bucket', price: 649 },
      { name: 'Smash Burger Combo', price: 449 },
      { name: 'Mango Sticky Rice', price: 249 },
      { name: 'Cold Brew Flask', price: 299 },
    ],
    categories: ['Mains', 'Sides', 'Desserts'],
    catKeys: ['mains', 'sides', 'desserts'],
    itemCats: ['mains', 'mains', 'mains', 'mains', 'desserts', 'sides'],
    quiz: {
      q: 'How hungry are we tonight?',
      options: [
        { label: 'Light & fresh', result: 'The {b} fresh bowls menu is perfect light, fast, and full of flavour.' },
        { label: 'Comfort cravings', result: 'Time for {b} comfort classics melty, crispy, exactly what you need.' },
        { label: 'Feed the squad', result: 'Order the {b} sharing platters built to feed the whole table.' },
      ],
    },
    poll: { q: 'What should {b} add to the menu next?', a: 'Spicy ramen', b: 'Loaded fries' },
    rate: 'How was your last meal from {b}?',
  },
  Finance: {
    items: [
      { name: 'Index Fund Starter Plan', price: 500 },
      { name: 'Digital Gold (per gram)', price: 7200 },
      { name: 'Tax-Saver ELSS Bundle', price: 5000 },
      { name: 'Fixed Deposit Booster', price: 10000 },
      { name: 'Micro-SIP Auto Invest', price: 100 },
      { name: 'Liquid Fund Wallet', price: 1000 },
    ],
    categories: ['Invest', 'Save', 'Insure'],
    catKeys: ['invest', 'save', 'insure'],
    itemCats: ['invest', 'invest', 'invest', 'save', 'invest', 'save'],
    quiz: {
      q: 'What is your money goal this year?',
      options: [
        { label: 'Grow wealth', result: 'Explore the {b} equity baskets built for long-term growth.' },
        { label: 'Save steadily', result: 'Set up a {b} auto-SIP small, consistent, powerful.' },
        { label: 'Stay protected', result: 'The {b} protection plans keep your goals safe whatever comes.' },
      ],
    },
    poll: { q: 'What matters most in a {b} app?', a: 'Lower fees', b: 'Better insights' },
    rate: 'How likely are you to recommend {b}?',
  },
  Beauty: {
    items: [
      { name: 'Vitamin C Glow Serum', price: 899 },
      { name: 'Hydra-Plump Moisturiser', price: 1199 },
      { name: 'Matte Liquid Lipstick', price: 599 },
      { name: 'Satin Foundation Stick', price: 1399 },
      { name: 'Rosewater Setting Mist', price: 749 },
      { name: 'Overnight Repair Mask', price: 999 },
    ],
    categories: ['Skincare', 'Makeup', 'Tools'],
    catKeys: ['skincare', 'makeup', 'tools'],
    itemCats: ['skincare', 'skincare', 'makeup', 'makeup', 'skincare', 'skincare'],
    quiz: {
      q: 'What does your skin want today?',
      options: [
        { label: 'A radiant glow', result: 'The {b} brightening range is your match hello, glow.' },
        { label: 'Deep hydration', result: 'Reach for the {b} hydration heroes thirsty skin, sorted.' },
        { label: 'A bold lip', result: 'The {b} colour studio has the shade long-wear, full pigment.' },
      ],
    },
    poll: { q: 'Which {b} shade range needs more love?', a: 'Warm tones', b: 'Cool tones' },
    rate: 'How happy are you with your {b} haul?',
  },
  Electronics: {
    items: [
      { name: 'Noise-Cancelling Earbuds', price: 4999 },
      { name: 'Smartwatch Series X', price: 8999 },
      { name: 'Mechanical Keyboard', price: 5499 },
      { name: '4K Action Camera', price: 12999 },
      { name: 'Fast-Charge Power Bank', price: 1799 },
      { name: 'Portable SSD 1TB', price: 6499 },
    ],
    categories: ['Audio', 'Wearables', 'Accessories'],
    catKeys: ['audio', 'wearables', 'accessories'],
    itemCats: ['audio', 'wearables', 'accessories', 'accessories', 'accessories', 'accessories'],
    quiz: {
      q: 'What upgrade are you after?',
      options: [
        { label: 'Better sound', result: 'The {b} audio line is calling immersive, crisp, wireless.' },
        { label: 'Smarter tracking', result: 'Level up with {b} wearables your day, quantified.' },
        { label: 'Faster workflow', result: 'The {b} pro accessories shave seconds off every task.' },
      ],
    },
    poll: { q: 'What should {b} launch next?', a: 'Foldable phone', b: 'AR glasses' },
    rate: 'How would you rate your new {b} gadget?',
  },
  Travel: {
    items: [
      { name: 'Goa Beach Escape (3N)', price: 14999 },
      { name: 'Himalayan Trek Package', price: 21999 },
      { name: 'Bali Honeymoon (5N)', price: 48999 },
      { name: 'Weekend City Break', price: 8999 },
      { name: 'Airport Lounge Pass', price: 1299 },
      { name: 'Travel Insurance Plus', price: 799 },
    ],
    categories: ['Beach', 'Mountains', 'City'],
    catKeys: ['beach', 'mountains', 'city'],
    itemCats: ['beach', 'mountains', 'beach', 'city', 'city', 'city'],
    quiz: {
      q: 'Where is your next trip taking you?',
      options: [
        { label: 'Sun & sand', result: 'The {b} beach collection is ready toes in the sand, soon.' },
        { label: 'Peaks & trails', result: 'Lace up for the {b} mountain escapes fresh air awaits.' },
        { label: 'City lights', result: 'The {b} city breaks have your weekend planned go explore.' },
      ],
    },
    poll: { q: 'Dream {b} destination for 2026?', a: 'Japan', b: 'Iceland' },
    rate: 'How was your recent trip booked with {b}?',
  },
  Generic: {
    items: [
      { name: 'Starter Plan', price: 499 },
      { name: 'Pro Plan', price: 1499 },
      { name: 'Team Bundle', price: 3999 },
      { name: 'Annual Saver', price: 9999 },
      { name: 'Add-on Pack', price: 299 },
      { name: 'Premium Support', price: 1999 },
    ],
    categories: ['Plans', 'Add-ons', 'Support'],
    catKeys: ['plans', 'addons', 'support'],
    itemCats: ['plans', 'plans', 'plans', 'plans', 'addons', 'support'],
    quiz: {
      q: 'What brings you to {b} today?',
      options: [
        { label: 'Just exploring', result: 'Start with the {b} free tour no commitment, all the highlights.' },
        { label: 'Ready to commit', result: 'The {b} Pro plan unlocks everything you came for.' },
        { label: 'Scaling a team', result: 'The {b} team bundle grows with you seats, tools, support.' },
      ],
    },
    poll: { q: 'What should {b} build next?', a: 'Mobile app', b: 'Integrations' },
    rate: 'How likely are you to recommend {b}?',
  },
};

function getContent(vertical) {
  return CONTENT[vertical] || CONTENT.Generic;
}

function applyBrand(str, brand) {
  return String(str).replace(/\{b\}/g, brand);
}

module.exports = { VERTICALS, TONES, CONTENT, getContent, applyBrand };
