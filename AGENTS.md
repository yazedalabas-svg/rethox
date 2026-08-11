# AGENTS.md

Behavioral guidelines to reduce common LLM coding mistakes, merged with rethox project instructions.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

# rethox — Project Instructions

Arabic RTL digital-books platform (MVP): catalog, search, cart, demo checkout, auth, synced reader with word highlighting, neural TTS, saved summaries, admin panel. UI text and error messages are in Arabic.

## Commands

```bash
npm install        # install all workspaces
npm run dev        # API on :4181 + web on :5173 (concurrently)
npm test           # vitest in both workspaces
npm run build      # API (tsc) then web (tsc -b && vite build)
```

Health check: `http://127.0.0.1:4181/api/health`. Demo admin: `admin@rethox.local` / `Rethox2026!` (dev only).

## Structure

- `apps/api` — Express 5 + TypeScript (ESM). Entry: `src/index.ts` (all routes). Auth helpers in `src/auth.ts`, JSON store in `src/store.ts` (persisted to `data/runtime-store.json`, seeded from `data/deploy-seed.json`), seed data in `src/seed.ts`.
- `apps/web` — React 19 + Vite. Almost everything lives in `src/App.tsx` (pages, providers, reader, auth UI, and community UI). API client in `src/api.ts`.
- `tools/` — `tts_edge.py` (Edge TTS narration with word boundaries, spawned by the API), `install-edge-tts.mjs` (pip bootstrap), RTF import script.
- `infra/supabase/schema.sql` — Supabase tables/RLS; `apps/api/prisma/schema.prisma` — target Postgres schema (not wired up yet).
- Deploy: Docker on Render (`render.yaml`, persistent disk at `/var/data`).

## Project notes

- Storage is a JSON file, not a real DB: `db()` returns mutable state, every write must call `save()`. No concurrency safety — keep handlers synchronous around mutations.
- Auth: short-lived access JWT + rotating refresh token (SHA-256 hash stored, HttpOnly cookie scoped to `/api/auth`). Admin checks happen server-side via `requireRole("ADMIN")`.
- Register/login are fully local (argon2, no email verification). Google sign-in is a server-side OAuth 2.0 code flow at `/api/auth/google` → `/api/auth/google/callback` using `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` env vars; a Google account with the same email links to the existing local account. Supabase is only used for the integrations status check.
- TTS responses are cached on disk under `data/tts-cache` keyed by a hash of voice+text; the cache key version string must be bumped when generation logic changes.
- Arabic search uses `normalizeArabic` (strips diacritics, unifies alef/yaa/taa marbuta) — apply it to both query and indexed text.
- Payment is fake (no real charges). Do not add real payment providers without explicit request.

## Imported Claude Cowork project instructions
