# pi-udk

Use the **UdK AI gateway** (`api.udk.digital`, "GenKI") in the [pi](https://pi.dev) coding agent. You log in with your normal UdK account. There are no API keys to copy around and no config files to edit.

- Logs you in with your UdK account and creates a personal API key for your computer.
- Adds the UdK models to pi (`/model`), with the right context sizes and image support.
- Walks you through the first steps with a short tutorial.

---

## How to set up

### 1. Install Node.js (once)

pi needs **Node.js 20.6 or newer**. Check with:

```bash
node --version
```

If that fails or shows an older version, install the LTS version from <https://nodejs.org> (Windows/macOS installer), or with a package manager:

```bash
brew install node            # macOS with Homebrew
winget install OpenJS.NodeJS.LTS   # Windows
```

### 2. Install pi (once)

```bash
npm install -g @earendil-works/pi-coding-agent
```

Check it works: `pi --version`.

### 3. Install the UdK extension (once)

```bash
pi install git:github.com/udk-gwk/pi-udk
```

This downloads the extension and registers it in `~/.pi/agent/settings.json`.

### 4. Start pi and log in

Open a terminal **in a project folder** (pi works on the files in the folder it is started in) and run:

```bash
pi
```

On first start pi asks **"Use the UdK AI gateway … Set it up now?"**. Choose *Yes, set it up*. You can also type `/udk` at any time.

1. **Log in** with your UdK username (or e-mail) and password, the same as for the web portal. The password is sent only to `auth.udk.digital` and is never saved.
2. pi creates an API key called `pi-<your computer name>` and stores it in `~/.pi/agent/auth.json`.
3. **Pick a model.** Start with `standard`. You're then asked whether pi should always start with this model.
4. pi sends a **test message**, then shows a few **tips**.

That's it. Type a request, for example *"explain what the files in this folder do"*, and press Enter.

### Models

| Model | Good for |
|---|---|
| `standard` | Default choice. A good all-rounder, runs on UdK hardware. |
| `small-fast` | Quick answers, runs on UdK hardware. Text only. |
| `large` | The biggest model UdK hosts for you. Understands images. |

Switch any time with `/model` or `Ctrl+L`. These three names stay the same while the models behind them get upgraded. Depending on your account there may be more models. Ones marked **⚠** (`cc/…`, `cx/…`) are run by outside companies (Anthropic, OpenAI) in the USA. **Anything you send them, including file contents pi reads while working, leaves UdK.** Don't use them for personal data or confidential work.

All UdK models currently handle up to 128K tokens of context. pi compacts long conversations automatically.

### Budget

Every UdK account has an AI budget. New accounts start small. `/udk status` shows how much your key has used. If the budget runs out, pi tells you. Ask the GenKI team for more.

### Commands

| Command | What it does |
|---|---|
| `/udk` | Setup: log in, key, model, test, tips (run again to switch account or model) |
| `/udk status` | Your key, usage so far, current and default model |
| `/udk models` | Re-read the list of models from the gateway |
| `/udk key` | Paste an existing API key instead of logging in (see below) |
| `/udk logout` | Remove the key from pi |

### Troubleshooting

- **"Your account requires a second factor"**: accounts with two-factor authentication can't log in from the terminal yet. Create a key in the browser at <https://api.udk.digital/keys> (log in, *Create key*, copy it), then run `/udk key` and paste it.
- **"UdK login failed"**: check username and password. After several failed attempts, the UdK login may lock you out for a while.
- **"… is not available for your UdK account"**: your account can't use that model. Use `standard`, `small-fast` or `large`.
- **"Your UdK AI budget is used up"**: ask the GenKI team.
- **The model server is busy or offline**: the UdK machines are shared. Try again shortly or switch model.
- **Several computers**: run `/udk` on each one. Each gets its own key, which you can see and delete at <https://api.udk.digital/keys>.
- **Remove everything**: `/udk logout`, then `pi remove git:github.com/udk-gwk/pi-udk`, then delete the key(s) at <https://api.udk.digital/keys>.

### Update

```bash
pi update --all          # pi itself and all extensions, including this one
```

---

## Details

### Security notes

- pi is an agent. **It reads files and runs commands without asking each time.** Start it in the project folder you want it to work on, ideally a git repository so you can undo changes. Read [pi's security notes](https://pi.dev) before letting it loose on important data.
- Your UdK password is typed into pi and sent directly to `auth.udk.digital`. It is not stored or logged. A browser-based login (no password in the terminal) is planned.
- The API key is stored like every other pi credential, in `~/.pi/agent/auth.json` (readable only by you). `/udk logout` removes it from pi. The key stays valid until you delete it in the web UI.
- Keys are created like the web UI creates them: no expiry and no per-key limit. The account budget still applies.

### Migrating from a hand-written setup

If `~/.pi/agent/models.json` already has a `"udk"` provider (the old manual setup), `/udk` offers to remove it, because it would override this extension. A backup copy of `models.json` is written next to it. If that block contains a working key, `/udk` can reuse it instead of logging in.

### How the login works

The terminal login does the same thing as the web portal's "UdK Login" button, over HTTP:

1. `POST /api/oauth/state {"provider":"oidc","intent":"login"}` on new-api returns a one-time `flow_token`, used as the OAuth `state`.
2. authentik `authorize` redirects to its authentication flow. The flow-executor API (`/api/v3/flows/executor/<flow>/`) takes identification and password, then user-login. Then comes the provider's authorization/consent flow, and finally a redirect with `?code=…`.
3. `GET /api/oauth/oidc?code=…&state=…` on new-api returns a short-lived dashboard session.
4. The key named `pi-<host>` is reused if it exists. Otherwise `POST /api/token/` creates it. `POST /api/token/{id}/key` returns the full key.
5. `POST /api/user/auth/logout` ends the dashboard session.

MFA stages (TOTP/WebAuthn) can't be done headlessly, so pi offers the paste-a-key path instead.

Gateway errors (quota messages that are only in Chinese, "no available channel for model … under group …") are rewritten into actionable English. The original text is kept in brackets for support.

### Files touched

| File | What |
|---|---|
| `~/.pi/agent/auth.json` | `{"udk": {"type": "api_key", "key": …}}`, mode 0600 |
| `~/.pi/agent/settings.json` | `defaultProvider` / `defaultModel`, only if you agree |
| `~/.pi/agent/models.json` | only when you accept the migration (backup kept) |
| `~/.pi/agent/pi-udk.json` | small state: onboarding dismissed, key name |

Writes use the same `proper-lockfile` locking as pi.

### Environment

- `PI_UDK_API_BASE`: gateway base URL (default `https://api.udk.digital`)
- `PI_CODING_AGENT_DIR`: pi's config directory (default `~/.pi/agent`), respected for every file above

### Development

```bash
git clone git@github.com:udk-gwk/pi-udk.git && cd pi-udk
npm install
npm run check      # tsc
npm test           # node:test, no network

# try it without touching your real pi config:
PI_CODING_AGENT_DIR=/tmp/pi-udk-test pi -e ./src/index.ts
```

Built against pi 0.87.1.
