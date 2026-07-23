#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { argv } from 'node:process';

const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
const msg = argv.slice(2).join(' ') || 'local snapshot';
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const branch = `local-work/${timestamp}`;

try {
  console.log(`Creating local branch ${branch}`);
  run(`git checkout -b ${branch}`);
} catch (err) {
  console.warn('Branch creation failed (it may already exist), continuing...');
}

console.log('Staging all changes...');
run('git add -A');

try {
  console.log(`Committing with message: ${msg}`);
  run(`git commit -m "${msg}"`);
} catch (err) {
  console.log('Nothing to commit or commit failed; changes may already be recorded.');
}

console.log('Local snapshot complete. To continue working:');
console.log(' - Run the dev server: npm run dev');
console.log(' - When ready to publish, merge or push the branch to GitHub and run the deploy workflow.');

console.log(`Your current branch: `);
run('git branch --show-current');
