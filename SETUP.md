# runlet: setup from start to finish

Runlet lets an AI assistant run shell commands on this computer and read the results through a remote MCP connection.

You need:

- a free Cloudflare account
- this repository
- Linux, macOS with Homebrew, or Windows 10/11 with Node 20+
- an MCP client that can add a remote/custom server by URL

The target machine does **not** need a public IP, open port, VPN, SSH exposure, or a local AI runtime. The runner makes outbound HTTPS requests to Cloudflare.

> [!WARNING]
> Commands run as your user. The Runlet connector URL is a credential: anyone who has it can ask Runlet to execute commands on this machine. Keep it private.

## 1. Prepare Cloudflare

1. Create an account at <https://dash.cloudflare.com/sign-up>.
2. Confirm your email and sign in.
3. You do not need to add a website or domain.
4. On a brand-new account, open **Compute (Workers)** once so Workers is initialised.

The free plan is sufficient for a small personal install.

## 2. Create the API token

The installer uses a Cloudflare API token to create the Worker and D1 database. It is not the credential your MCP client uses — that is the connector URL, created later.

The installer also writes this token into the local config, because the runner needs one of its own: it reaches the queue over D1's HTTP API on every poll. The two uses have different needs, and it is worth knowing which is which.

**The installer** needs all three permissions below: it discovers the account, creates the database, deploys the Worker, and sets the Worker's secrets. It needs them once.

**The runner** needs no Cloudflare permissions at all. It reaches its queue through its own Worker, with a per-machine bearer token the installer generates, so the machine whose job is running shell commands from the internet holds no account credential. The installer does not write `CLOUDFLARE_API_TOKEN` into the machine's config, which is why a re-run asks for it again.

1. Open <https://dash.cloudflare.com/profile/api-tokens>.
2. Click **Create Token** and choose **Create Custom Token**.
3. Name it `runlet`.
4. Add these permissions:

   | Scope | Permission | Level |
   |---|---|---|
   | Account | Workers Scripts | Edit |
   | Account | D1 | Edit |
   | Account | Account Settings | Read |

5. Include the account where Runlet should live.
6. Create the token and copy it somewhere temporary and private. Cloudflare shows it once.

If the token can access several accounts, the installer may also ask for the account ID.

### Use a separate token per machine

Nothing is stored on the machine any more, so there is little left to share: the installer's token is used for provisioning and then forgotten. Delete it afterwards, or keep it somewhere private for the next re-run — just not on the machines themselves.

If you do keep one long-lived token, still give each machine its own. A D1 token is account-wide, so one shared token means compromising any machine costs you all of them, and revoking it to fix that breaks them all at once.

## 3. Run the installer

### Linux

```bash
cd runlet
./install.sh
```

Paste the Cloudflare API token when prompted.

### macOS

Install [Homebrew](https://brew.sh) first if it is not already installed, then run the same installer in Terminal:

```bash
cd runlet
./install.sh
```

The installer finds Homebrew on Apple Silicon (`/opt/homebrew`) or Intel (`/usr/local`), or uses the `brew` already on your PATH. It installs `jq`, GNU coreutils, OpenSSL 3, and Python 3. If a suitable Node is missing, it installs Homebrew's Node 22 for Cloudflare provisioning.

It creates `~/Library/LaunchAgents/org.runlet.runner.plist`, starts it in your desktop login session, and starts it again at future logins. When installing over SSH without a desktop login, the agent is saved for your next login; you can run `node runlet.mjs` manually meanwhile. `./install.sh --no-service` skips LaunchAgent creation and startup.

The runner uses Homebrew's GNU utilities internally; your shell configuration is not changed. To make `runlet` available in Terminal, add this to `~/.zprofile` (zsh) or `~/.bash_profile` (bash), then open a new terminal:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

The Mac must be awake and connected to process commands. This is a per-user login agent, not a system-wide daemon.

### Windows

Windows runs natively: `win\runlet.mjs` under Node, started by a Scheduled
Task at logon. WSL2 is no longer used or required.

1. Put the repository somewhere convenient, for example `C:\runlet`.
2. Install [Node 20+](https://nodejs.org) if you do not have it. The installer
   will try `winget install OpenJS.NodeJS.LTS` for you if winget is available.
3. Open PowerShell and run:

   ```powershell
   cd C:\runlet
   Set-ExecutionPolicy -Scope Process Bypass
   .\install.ps1
   ```

4. Paste the Cloudflare API token when it asks.
5. The runner is registered as the Scheduled Task `runlet`, running as you,
   starting at logon and restarting if it stops. Check it with:

   ```powershell
   Get-ScheduledTask runlet
   Get-ScheduledTaskInfo runlet
   Get-Content -Wait "$env:APPDATA\runlet\runner.log"
   ```

Config lives in `%APPDATA%\runlet\` rather than `~/.config/runlet/`, and the
nonce history in `%LOCALAPPDATA%\runlet\`.

## 4. What the installer creates

The installer:

1. checks required local dependencies
2. creates or finds a D1 database named `runlet-<site>`
3. applies `schema.sql`
4. creates or finds a Worker named `runlet-<site>`
5. ensures a `workers.dev` subdomain exists
6. generates the shared HMAC signing key
7. generates the secret URL path
8. stores the Worker secrets
9. deploys the Worker
10. runs an end-to-end smoke test
11. writes local config under `~/.config/runlet/` (`%APPDATA%\runlet\` on Windows)
12. installs and starts `runlet.mjs` as a systemd user service (Linux), a LaunchAgent (macOS), or a Scheduled Task (Windows)

`<site>` defaults to the hostname. Several machines can therefore share one Cloudflare account without sharing a Worker or database.

Re-running the installer is safe. Existing stack IDs and secrets are reused unless you deliberately remove or rotate them.

### Non-interactive setup

```bash
cp install.conf.example install.conf
```

Fill in the values before installation. Keep this file private because it may contain the Cloudflare API token, and delete it when you no longer need it.

## 5. Save the connector URL

At the end, the installer prints an address similar to:

```text
https://runlet-example.example.workers.dev/jog-lapel-flame-lift-charm/mcp
```

The exact hostname will differ. The random word path is the important secret. The installer also attempts to copy the URL to your clipboard and open a connector page.

**Do not post this URL, commit it to Git, paste it into issue trackers, or share it with an assistant you do not trust.** It is effectively a capability token for shell access through Runlet.

## 6. Connect your MCP client

Add the printed URL as a remote/custom MCP server or connector. Runlet authenticates through the secret URL, so choose **no additional authentication** if your client asks.

The exact menu name differs between clients. Claude calls this a custom connector. ChatGPT can use a custom connector/plugin surface where available. Other MCP hosts generally ask for the remote server URL.

Start with a harmless command such as:

```text
uname -a
```

or:

```text
printf 'hello from runlet\n'
```

The assistant receives Runlet's tool descriptions automatically, including how to wait, run work in the background, detach it, cancel it, and retrieve results later.

## 7. Give the assistant sensible operating rules

Runlet intentionally does not impose a command allowlist. If your MCP client supports project or custom instructions, tell the assistant how you want it to use the machine.

For example:

> You can run shell commands on my computer through Runlet. Commands run as me in a fresh `bash -lc` shell. Prefer read-only inspection unless I have asked for a change. Be cautious with deletion, package changes, service changes, credentials, and network exposure. For long jobs, use background execution or detach them and collect the result later. Keep large output bounded with tools such as `head`, `tail`, `grep`, and `sed`.

Adapt that to your own trust model. Runlet provides transport and verification; the operating policy belongs to you and the assistant using it.

## Everyday operation

On Linux, the runner starts automatically as a systemd user service.

```bash
systemctl --user status runlet
journalctl --user -u runlet -f
runlet status
runlet status 30
```

Stop and start it with:

```bash
systemctl --user stop runlet
systemctl --user start runlet
```

On macOS, inspect the agent and follow its log with:

```bash
launchctl print "gui/$(id -u)/org.runlet.runner"
tail -f "$HOME/Library/Logs/runlet/runner.log"
runlet status
```

Stop and start it with:

```bash
launchctl bootout "gui/$(id -u)/org.runlet.runner"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/org.runlet.runner.plist"
```

These commands apply to your desktop login session. Logging out stops the agent; logging in starts it again. Logs append to `runner.log`; rotate or truncate that file periodically if needed.

## Rotate the connector URL

If the URL is exposed:

1. Open `~/.config/runlet/env`.
2. Remove the `RUNLET_URL_SECRET=...` line.
3. Run the installer again.
4. Replace the old connector URL in every MCP client.

The old path stops being valid after the Worker is redeployed with the new secret.

## Rotate a machine's runner token

`RUNLET_RUNNER_TOKEN` is what a machine presents to its own Worker. Replacing it touches neither the database nor the connector URL:

1. Delete the `RUNLET_RUNNER_TOKEN=` line from `~/.config/runlet/env` (`%APPDATA%\runlet\env` on Windows).
2. Re-run the installer: it mints a new one and sets it as the Worker's secret.
3. Watch one command run end to end.

The old token stops working the moment the Worker's secret is replaced, so the runner is briefly refused (a 404) until the new config is read.

## Find a lost connector URL

Print it from the install folder:

```sh
./install.sh --print-url
```

This only reads `~/.config/runlet/env`; it needs no token and changes nothing. The components are stored there:

```text
RUNLET_WORKER_URL=...
RUNLET_URL_SECRET=...
```

The full connector URL is:

```text
<RUNLET_WORKER_URL>/<RUNLET_URL_SECRET>/mcp
```

Keep it private when copying or displaying it.

## Tune the runner

Common settings in `~/.config/runlet/env`:

```text
RUNLET_POLL=5
RUNLET_CMD_TIMEOUT=600
RUNLET_MAX_OUTPUT=60000
RUNLET_PARALLEL=1
RUNLET_BACKGROUND_MAX=4
RUNLET_DETACH_CHECK=3
RUNLET_PROGRESS_EVERY=10
RUNLET_KEEP_DAYS=30
RUNLET_LOAD_MAX=0
```

`RUNLET_PARALLEL=1` gives predictable one-at-a-time foreground execution. Background jobs are separately limited by `RUNLET_BACKGROUND_MAX`.

`RUNLET_LOAD_MAX=0` disables load-based admission control. Set it to a positive value to stop Runlet starting new work while the 1-minute load average is above that threshold.

Several tuning values are re-read while the runner is operating, so many operational changes do not require a service restart.

## Troubleshooting

### Commands stay pending

Check the service and log:

```bash
systemctl --user status runlet
journalctl --user -u runlet -n 100
```

On macOS, use the `launchctl print` and `tail` commands above instead.

A stopped runner, Cloudflare API problem, bad local config, or active load ceiling can leave work pending.

### A command says `rejected`

The runner rejected the signature or nonce. If signing code or keys changed, run:

```bash
./tests/check-signing.sh
```

The Worker and runner must use the same HMAC key and byte-for-byte signing format.

### A command says `error` after a restart

Runlet deliberately marks commands that were in flight when the runner restarted as ambiguous. The command may have partly or fully executed before the process disappeared. Inspect its effects before running it again.

### A command timed out

The default command limit is 600 seconds. Increase `RUNLET_CMD_TIMEOUT` if the work is legitimately longer, or use background execution and retrieve the result later.

### The queue is blocked by a long foreground command

Ask the assistant to `detach` it. The command keeps running while later work proceeds. If it should stop instead, use `cancel`.

### The connector URL no longer works

Confirm that the MCP client has the current URL. After rotating `RUNLET_URL_SECRET`, every client using the old URL must be updated.

## Removing Runlet

Stop and disable the local service:

```bash
systemctl --user disable --now runlet
```

On macOS, unload the agent and remove its login definition instead:

```bash
launchctl bootout "gui/$(id -u)/org.runlet.runner"
rm "$HOME/Library/LaunchAgents/org.runlet.runner.plist"
```

You can then remove the local config and repository. To remove the cloud side too, delete the Runlet Worker and D1 database from Cloudflare.

Be deliberate when deleting D1: it contains Runlet's command and result history until rows are pruned.
