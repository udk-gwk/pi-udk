# pi-udk

A [pi](https://pi.dev) extension for the UdK AI gateway (`https://api.udk.digital`, new-api):

- **Login with your UdK account.** Your UdK username and password (LDAP via authentik) are used once to open a dashboard session, then that session is logged out again.
- **Personal API key.** A key named `pi-<hostname>` is created on the gateway, or reused if this computer already has one. It is stored as a normal pi credential in `~/.pi/agent/auth.json` (`{"udk": {"type": "api_key", …}}`, mode 0600). The password is never stored.
- **`udk` provider.** Registers the gateway's models with sensible context sizes, image support and a warning marker for external models (`cc/*`, `cx/*`). The list is refreshed from `/v1/models` and cached by pi, so it also works offline.
- **Onboarding tutorial.** Covers picking a model (`standard` / `small-fast` / `large` first), optionally making it the default, a test message, and a few pi basics.
- **Migration.** Offers to remove an older hand-written `udk` provider from `~/.pi/agent/models.json` (which would override this extension). The file is backed up first, and a working key found there can be reused.

## Install

```bash
pi install git:git.universe.io/udk/pi-udk   # once pushed; remote not set up yet
# or, from a checkout:
git clone … && cd pi-udk && npm install && pi install .
```

Start `pi`. If no UdK key is configured, it offers to set one up. Or run `/udk` at any time.

## Commands

| Command | What it does |
|---|---|
| `/udk` | Guided setup: login → key → model → test → tips |
| `/udk status` | Key name, usage so far, current/default model |
| `/udk models` | Re-read the model list from the gateway |
| `/udk key` | Paste an existing key (created at https://api.udk.digital/keys) instead of logging in |
| `/udk logout` | Remove the key from pi (it stays valid on the gateway; delete it in the web UI) |

The setup only runs in the interactive TUI. In print/RPC mode the provider still works with a stored key (`pi --model udk/standard -p "…"`).

## How the login works

The flow uses no browser and needs no server change. It is exactly what the web portal's "UdK Login" button does, driven over HTTP:

1. `POST /api/oauth/state {"provider":"oidc","intent":"login"}` on new-api returns a one-time `flow_token`, used as the OAuth `state`.
2. `GET https://auth.udk.digital/application/o/authorize/?client_id=…&redirect_uri=https://api.udk.digital/oauth/oidc&state=…` redirects into authentik's authentication flow.
3. The authentik flow executor API (`/api/v3/flows/executor/<flow>/`) takes identification and password, then user-login and consent, and finally redirects back with `?code=…`.
4. `GET /api/oauth/oidc?code=…&state=…` on new-api returns a short-lived dashboard `access_token`.
5. `POST /api/token/` creates the key, `GET /api/token/search` finds its id, and `POST /api/token/{id}/key` returns the full key.
6. `POST /api/user/auth/logout` ends the dashboard session.

Accounts that need MFA (TOTP/WebAuthn stages) can't use this headless path. The extension then offers to paste a key instead. See `plans/pi-udk-browser-login.md` in the infrastructure repo for the browser-based login that avoids typing the password into pi.

Keys are created like the web UI creates them: no expiry and no per-key limit. The account's own quota and group still apply.

## Environment

- `PI_UDK_API_BASE`: gateway base URL (default `https://api.udk.digital`)
- `PI_CODING_AGENT_DIR`: pi's config dir (default `~/.pi/agent`), respected for all files touched

Files written: `auth.json` (key), `settings.json` (`defaultProvider`/`defaultModel`, only if you agree), `models.json` (only the migration, with a backup), `pi-udk.json` (small state: onboarding dismissed, key name). Writes use the same `proper-lockfile` locking as pi.

## Development

```bash
npm install
npm run check      # tsc
npm test           # node:test, no network
pi -e ./src/index.ts
PI_CODING_AGENT_DIR=/tmp/pi-test pi -e ./src/index.ts   # try onboarding without touching your real config
```
