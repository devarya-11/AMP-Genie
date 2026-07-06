'use strict';

// Generates every module × every vertical, runs each through the real
// AMP4EMAIL validator, and prints the matrix. Exit code 1 if anything fails.

const { generate, MODULE_IDS, MODULES, VERTICALS } = require('../server/generate');
const { validate } = require('../server/validator');

async function main() {
  const results = [];
  let failures = 0;

  for (const moduleId of MODULE_IDS) {
    for (const vertical of VERTICALS) {
      const g = generate({ brand: 'Zomato', vertical, tone: 'Playful', currency: 'INR', moduleId });
      const v = await validate(g.ampHtml);
      if (!v.pass) failures++;
      results.push({ moduleId, vertical, status: v.status, errors: v.errors, html: g.ampHtml });
    }
  }

  // Print matrix grid
  const pad = (s, n) => String(s).padEnd(n);
  const colW = 9;
  console.log('\nAMP4EMAIL VALIDATOR MATRIX (real amphtml-validator)\n');
  let header = pad('module \\ vertical', 22);
  for (const v of VERTICALS) header += pad(v.slice(0, colW - 1), colW);
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const moduleId of MODULE_IDS) {
    let row = pad(`${moduleId} (${MODULES[moduleId].kind})`.slice(0, 21), 22);
    for (const v of VERTICALS) {
      const r = results.find((x) => x.moduleId === moduleId && x.vertical === v);
      row += pad(r.status === 'PASS' ? 'PASS' : 'FAIL', colW);
    }
    console.log(row);
  }

  // Print any errors in detail
  const failed = results.filter((r) => r.status !== 'PASS');
  if (failed.length) {
    console.log('\n--- FAILURES ---');
    for (const f of failed) {
      console.log(`\n[${f.moduleId} × ${f.vertical}]`);
      for (const e of f.errors) console.log(`  ${e.severity} ${e.line}:${e.col} ${e.message}`);
    }
  }

  const total = results.length;
  console.log(`\n${total - failures}/${total} combinations PASS with zero errors.`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
