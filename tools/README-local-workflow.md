Local-first workflow
====================

This helper lets you keep working locally and save snapshots as local branches without pushing immediately.

Usage
-----

From repository root:

```bash
node tools/local-workflow.mjs "optional commit message"
```

What it does
-----------
- Creates a branch named `local-work/<timestamp>` (if possible).
- Stages all changes and commits with the provided message (or `local snapshot`).
- Does NOT push to GitHub.

Workflow suggestion
-------------------
1. Use `node tools/local-workflow.mjs "WIP: notes"` regularly to snapshot work.
2. Run the dev server locally to preview: `npm run dev`.
3. When ready, push or create a PR from the branch: `git push origin <branch>` and use `tools/push-and-deploy.mjs` if you want CI/deploy orchestration.
