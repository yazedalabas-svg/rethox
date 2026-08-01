Push-and-deploy helper
======================

Rethox Auto Sync (Windows)
--------------------------

Double-click `Rethox-AutoSync.cmd` in the repository root. Keep the Arabic
window open while editing. It watches project files and, after 8 quiet seconds:

1. builds the API and web app;
2. runs the complete test suite;
3. creates a version marker and commit;
4. pushes `main` to GitHub;
5. starts the Render workflow; and
6. waits until the same version is live on `https://rethox.online`.

The window also supports immediate publishing, pausing file monitoring, and
opening the live site, GitHub Actions, or Render. Only one Auto Sync window can
run at a time. Secrets, build output, logs, runtime data, and the local
`wild-paper-877c` experiment are excluded.

Usage
-----

Requirements:
- Node 18+ (for global fetch)
- `GITHUB_TOKEN` environment variable (a PAT with `repo` scope) to poll Actions
- Optionally `CF_BUILD_TOKEN` to perform a local `npx wrangler deploy`

Run from repository root:

```bash
node tools/push-and-deploy.mjs "commit message"
```

Environment variables:
- `GITHUB_TOKEN` — required to poll GitHub Actions for workflow status.
- `CF_BUILD_TOKEN` — when present, the tool will run `npm run build` and `npx wrangler deploy` locally after CI succeeds.
- `PUSH_WAIT_TIMEOUT_MS` — optional timeout in ms (default 30m).
- `PUSH_POLL_INTERVAL_MS` — optional poll interval (default 10s).

Notes
-----
- This tool stages all changes, commits (if any), pushes to the current branch, waits for the GitHub Actions run to complete for the pushed commit, and optionally triggers a local deploy.
- Do not store secrets in the repository. Add `CF_BUILD_TOKEN` and `GITHUB_TOKEN` as environment variables or use a secure credential store.
