'use strict';

// Deterministic proof (no network) that a product NAME maps to the CORRECT
// category — i.e. the contradiction bug ("Coca-Cola under Wood-Fired Margherita",
// "storefront under Korean Fried Chicken") cannot recur. Each row asserts the
// canonical category the resolver derives for a real product name.

const { categorize } = require('../server/category');

// [name, vertical, expectedCategory]
const CASES = [
  // ---- the exact bug cases ----
  ['Wood-Fired Margherita', 'Food', 'pizza'],
  ['Korean Fried Chicken', 'Food', 'fried-chicken'],
  ['Korean Fried Chicken Bucket', 'Food', 'fried-chicken'],
  // ---- Food spread (must NOT cross-wire) ----
  ['Butter Chicken & Naan', 'Food', 'curry'],          // chicken, but a curry — not fried-chicken
  ['Truffle Mushroom Risotto', 'Food', 'pasta-risotto'],
  ['Smash Burger Combo', 'Food', 'burger'],
  ['Death by Chocolate', 'Food', 'dessert'],
  ['Mango Sticky Rice', 'Food', 'dessert'],
  ['Cold Brew Coffee', 'Food', 'beverage'],
  ['Cold Brew Flask', 'Food', 'beverage'],
  ['Loaded Nachos', 'Food', 'sides'],
  ['Margarita Cocktail', 'Food', 'beverage'],          // the DRINK spelling → beverage, not pizza
  // ---- Fashion ----
  ['Relaxed Linen Resort Shirt', 'Fashion', 'shirt-top'],
  ['High-Rise Wide-Leg Jeans', 'Fashion', 'trousers'],
  ['Chunky Sole Court Sneakers', 'Fashion', 'shoes'],
  ['Tailored Single-Breast Blazer', 'Fashion', 'jacket-coat'],
  ['Cropped Denim Jacket', 'Fashion', 'jacket-coat'],  // "denim" but a JACKET — not trousers
  ['Quilted Crossbody Bag', 'Fashion', 'bag'],
  ['Pleated Midi Skirt', 'Fashion', 'dress'],
  ['Vintage Check Cashmere Scarf', 'Fashion', 'accessory'],
  ['Suede Chelsea Boots', 'Fashion', 'shoes'],
  // ---- Finance (abstract on-theme) ----
  ['Equity Growth Fund', 'Finance', 'fund-invest'],
  ['Tax-Saver ELSS Bundle', 'Finance', 'fund-invest'],
  ['Micro-SIP Auto Invest', 'Finance', 'fund-invest'],
  ['Fixed Deposit Booster', 'Finance', 'savings'],
  ['Digital Gold (per gram)', 'Finance', 'gold'],
  ['iProtect Smart Term Plan', 'Finance', 'insurance'],
  ['Easy Retirement SIP', 'Finance', 'pension'],        // retire → pension (before fund)
  // ---- Beauty / Electronics / Travel ----
  ['Matte Liquid Lipstick', 'Beauty', 'lipstick-makeup'],
  ['Vitamin C Glow Serum', 'Beauty', 'skincare'],
  ['Rosewater Setting Mist', 'Beauty', 'fragrance'],
  ['Noise-Cancelling Earbuds', 'Electronics', 'headphones'],
  ['Smartwatch Series X', 'Electronics', 'smartwatch'],
  ['4K Action Camera', 'Electronics', 'camera'],
  ['Goa Beach Escape (3N)', 'Travel', 'beach'],
  ['Himalayan Trek Package', 'Travel', 'mountains'],
  // ---- cross-vertical collision guards (the SAME word must resolve to the
  //      right category PER VERTICAL — vertical scoping, not global keywords) ----
  ['Liquid Fund Wallet', 'Finance', 'savings'],       // "wallet" in Finance ≠ a handbag
  ['Leather Bifold Wallet', 'Fashion', 'bag'],        // "wallet" in Fashion IS a bag
  ['Classic Analog Watch', 'Electronics', 'smartwatch'], // "watch" → wearable, not finance
  ['Charcoal Clay Mask', 'Beauty', 'skincare'],       // "mask" in Beauty ≠ apparel
  ['Recovery Compression Band', 'Electronics', 'smartwatch'], // "band" → wearable, not accessory
  // ---- fallbacks: unknown name in a known vertical → vertical default (medium) ----
  ['Mystery Special', 'Food', 'food-generic'],
  ['Brand New Thing', 'Fashion', 'apparel-generic'],
];

let pass = 0, fail = 0;
const W = 34;
console.log('\nCATEGORY RESOLUTION — product name → correct category (no contradictions)\n');
console.log('  ' + 'PRODUCT NAME'.padEnd(W) + 'VERTICAL'.padEnd(12) + 'GOT'.padEnd(18) + 'EXPECT'.padEnd(18) + 'OK');
console.log('  ' + '-'.repeat(W + 12 + 18 + 18 + 3));
for (const [name, vertical, expect] of CASES) {
  const got = categorize(name, vertical);
  const ok = got.category === expect;
  if (ok) pass++; else fail++;
  console.log('  ' + name.slice(0, W - 1).padEnd(W) + String(vertical).padEnd(12) + String(got.category).padEnd(18) + expect.padEnd(18) + (ok ? '✓' : '✗  (' + got.confidence + ')'));
}
console.log('  ' + '-'.repeat(W + 12 + 18 + 18 + 3));
console.log(`\n  ${pass}/${CASES.length} correct${fail ? `  —  ${fail} WRONG` : '  —  no contradictions'}`);
process.exit(fail ? 1 : 0);
