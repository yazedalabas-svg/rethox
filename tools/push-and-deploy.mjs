#!/usr/bin/env node
import { execSync } from "node:child_process";
import { env } from "node:process";

const run = (cmd) => execSync(cmd, { stdio: [0, 'pipe', 'pipe'] }).toString().trim();
const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

const message = process.argv.slice(2).join(" ") || `Update: ${new Date().toISOString()}`;
const branch = safe(() => run("git rev-parse --abbrev-ref HEAD"), "main");
console.log(`Branch: ${branch}`);

console.log("Staging changes...");
run("git add -A");
console.log(`Committing: ${message}`);
const committed = safe(() => { run(`git commit -m ${JSON.stringify(message)}`); return true; }, false);
if (!committed) console.log("No changes to commit.");

console.log("Pushing to origin...");
run(`git push origin ${branch}`);

const sha = run("git rev-parse HEAD");
console.log(`Pushed commit ${sha}`);

const remoteUrl = run("git remote get-url origin");
console.log(`Remote URL: ${remoteUrl}`);
let ownerRepo = "";
if (remoteUrl.startsWith("git@")) {
  // git@github.com:owner/repo.git
  ownerRepo = remoteUrl.replace(/^git@[^:]+:/, "").replace(/\.git$/, "");
} else {
  // https://github.com/owner/repo.git
  ownerRepo = remoteUrl.replace(/https?:\/\/[^/]+\//, "").replace(/\.git$/, "");
}
const [owner, repo] = ownerRepo.split("/");
if (!owner || !repo) throw new Error("Failed to parse remote origin URL to owner/repo");

const githubToken = env.GITHUB_TOKEN || env.GH_TOKEN;
if (!githubToken) {
  console.warn("No GITHUB_TOKEN found; cannot poll GitHub Actions. Set GITHUB_TOKEN in env to enable waiting for CI.");
  process.exit(0);
}

const headers = { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github.v3+json' };
const apiBase = `https://api.github.com/repos/${owner}/${repo}`;

const waitForWorkflow = async () => {
  const start = Date.now();
  const timeoutMs = Number(env.PUSH_WAIT_TIMEOUT_MS || 30 * 60 * 1000);
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${apiBase}/actions/runs?head_sha=${sha}`, { headers });
      if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
      const data = await res.json();
      const run = (data.workflow_runs || [])[0];
      if (!run) {
        // no run yet — try listing by branch
        const res2 = await fetch(`${apiBase}/actions/runs?branch=${branch}`, { headers });
        const data2 = await res2.json();
        const run2 = (data2.workflow_runs || [])[0];
        if (run2) {
          console.log(`Found workflow run ${run2.id} (status=${run2.status})`);
          if (run2.status === 'completed') return run2.conclusion === 'success';
        }
      } else {
        console.log(`Found workflow run ${run.id} (status=${run.status})`);
        if (run.status === 'completed') return run.conclusion === 'success';
      }
    } catch (err) {
      console.warn('GitHub poll error:', String(err));
    }
    await new Promise(r => setTimeout(r, Number(env.PUSH_POLL_INTERVAL_MS || 10_000)));
  }
  throw new Error('Timed out waiting for GitHub Actions');
};

(async () => {
  console.log('Waiting for GitHub Actions to complete...');
  try {
    const success = await waitForWorkflow();
    if (!success) {
      console.error('Workflow completed but failed. Check Actions on GitHub.');
      process.exit(2);
    }
    console.log('Workflow succeeded.');
  } catch (err) {
    console.error('Error while waiting for workflow:', String(err));
    process.exit(3);
  }

  // Optional local deploy if CF_BUILD_TOKEN is present
  if (env.CF_BUILD_TOKEN) {
    console.log('CF_BUILD_TOKEN present — running local deploy: npm run build && npx wrangler deploy');
    try {
      run('npm run build');
      // Pass token into environment for wrangler
      run(`npx wrangler deploy`);
      console.log('Local wrangler deploy finished.');
    } catch (err) {
      console.error('Local deploy failed:', String(err));
      process.exit(4);
    }
  } else {
    console.log('No CF_BUILD_TOKEN provided — skipping local deploy. The GitHub workflow should have deployed the site.');
  }
})();
