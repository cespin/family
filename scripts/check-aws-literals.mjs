#!/usr/bin/env node
// Fails when a tracked or about-to-be-tracked file contains an AWS region, a 12-digit account ID
// or the AWS profile in use. Those values are always arguments in this project, never content.
//
// There are deliberately no path exclusions. Use a placeholder such as <region> in docs and a
// fake value such as "local" in test fixtures.
//
// Usage: node scripts/check-aws-literals.mjs --profile <name>

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const REGION = /\b(?:us|eu|ap|sa|ca|me|af|il|mx)-(?:gov-)?(?:north|south|east|west|central|northeast|northwest|southeast|southwest)-\d\b/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ACCOUNT_ID = /(?<![\w+/=.])\d{12}(?![\w+/=])/;

function profileArgument(argv) {
  const index = argv.indexOf('--profile');
  const value = index === -1 ? undefined : argv[index + 1];
  if (!value || value.startsWith('--')) {
    console.error('Usage: node scripts/check-aws-literals.mjs --profile <name>');
    process.exit(2);
  }
  return value;
}

function candidateFiles() {
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return output.split('\0').filter(Boolean);
}

function findings(file, profile) {
  let text;
  try {
    text = readFileSync(join(ROOT, file), 'utf8');
  } catch {
    return []; // Deleted from the working tree but still in the index.
  }
  if (text.includes('\0')) return []; // Binary file.

  const found = [];
  text.split('\n').forEach((rawLine, index) => {
    const line = rawLine.replace(UUID, '');
    if (REGION.test(line)) found.push([index + 1, 'AWS region']);
    if (ACCOUNT_ID.test(line)) found.push([index + 1, '12-digit account ID']);
    if (rawLine.includes(profile)) found.push([index + 1, 'AWS profile name']);
  });
  return found.map(([line, kind]) => `${file}:${line}: ${kind}`);
}

const profile = profileArgument(process.argv.slice(2));
const problems = candidateFiles().flatMap((file) => findings(file, profile));

if (problems.length > 0) {
  console.error('AWS values must be passed as arguments, never written into files:');
  problems.forEach((problem) => console.error(`  ${problem}`));
  process.exit(1);
}
console.log('check-aws-literals: no AWS literals found');
