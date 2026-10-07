# HANDOFF — state for whoever picks this up next

Last updated 2026-09-28. Read this, then `README.md` § Details, then the infra page
`~/dev/udk/infrastructure/services/pi-udk.md` (facts, measurements, gotchas, open items).

## Where things are

| What | Where |
|---|---|
| Code | `~/dev/udk/repos/pi-udk` → `github.com/udk-gwk/pi-udk` (public), branch `main`, tag `v0.1.0` |
| Infra note | `infrastructure/services/pi-udk.md` + plan `infrastructure/plans/pi-udk-browser-login.md`, commit `9fc7c61` — **not pushed** (infra repo is 2 ahead of origin; the other one, `6a388f3`, is the user's) |
| new-api source | `~/dev/udk/repos/new-api` — read it instead of scraping the SPA |
| pi | `pi` v0.87.1 (mise Node 22.22.2); docs in `node_modules/@earendil-works/pi-coding-agent/docs/` |

## Source map

- `src/gateway.ts` — HTTP client: headless OIDC login (authentik flow executor, runs *every*
  `/if/flow/<slug>/` it lands on — auth flow then consent flow), key find/reveal/create, usage,
  `/v1/models`. `GatewayError.kind`: credentials / unsupported (MFA) / network / server.
- `src/index.ts` — the extension: provider `udk`, `/udk` (setup|status|models|key|logout),
  first-run prompt, onboarding, `message_end` hook that rewrites gateway errors.
- `src/errors.ts` — new-api error → English (quota in Chinese, no channel for group, bad key, 5xx).
- `src/models.ts` — per-model metadata (context, vision, blurbs), aliases, external (`cc/`, `cx/`).
- `src/storage.ts` — locked JSON for auth.json / settings.json / models.json migration / pi-udk.json.
- `src/form.ts` — masked multi-field TUI form.

## Working rules

- Never touch the real `~/.pi/agent` in tests: `PI_CODING_AGENT_DIR=/tmp/<x> pi -e ./src/index.ts`.
  `~/.pi/agent/models.json` still holds the user's old hand-written `udk` block with a plaintext
  key — intentional, never print it.
- `npm run check && npm test` before every commit; scan for `sk-` strings before pushing.
- Releases: bump `package.json` version, `git tag -a vX.Y.Z`, `git push --follow-tags`.
  Anyone with push access can ship code that sees students' passwords — keep it small.
- Infra repo: `STATE.md` + `LESSONS.md` first; the user keeps unrelated uncommitted edits there —
  commit only your own files.
- No authentik / new-api changes without the user; server ideas go in a plan.

## Verified (2026-09-28)

- Full password login with the user's account (group `genki`), incl. consent flow; key reuse.
- Agent task (read/edit/bash) on `standard`, `small-fast`, `large`.
- All aliases: 131 072-token context cap. `standard` + `small-fast`: no images; `large`: images OK.
- `pi install git:github.com/udk-gwk/pi-udk` into a fresh config dir works.
- Friendly "model not available for group" error seen live; quota messages only unit-tested.

## Next

1. Test with a `default`-group student account (model list, quota/"not available" messages live).
2. User decides the student quota (default 500 000 = "$1") → `services/api-access-model.md`.
3. Link `services/pi-udk.md` from `services/api.md` ("Used by") and `services/services.md`
   once the user's pending edits there are committed. Push the infra repo when the user says so.
4. Record the authentik version (needed for plan option B).
5. Later: browser login (plan option A — new-api `/cli-login` + loopback + PKCE); then hide the
   password path behind `PI_UDK_PASSWORD_LOGIN=1`.
6. Ideas not started: a scheduled login check with a service account (catches authentik/new-api
   upgrades breaking login); `/udk logout` offering to delete the key on the gateway; npm publish
   (`pi-udk` name was free on 2026-09-28).

## Loose ends from this session

- A `pi-<hostname>` key from the user's login test exists on the gateway — user decides whether to
  keep it (https://api.udk.digital/keys).
- `/tmp/pi-udk-test` is the user's test config dir; safe to delete.
