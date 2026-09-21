# Moving a Runlet install to Sasonica Shell

Sasonica Shell was called Runlet until 21 September 2026. The rename was done
outright, with no compatibility layer: the new code reads none of the old
names. So an existing install does not upgrade in place. It gets a **new**
Worker and D1 database under the new name, the old ones are deleted once the
new ones work, and the assistants are pointed at a new connector URL.

What carries over: `relay.key` (the signing scheme is unchanged, so the key is
still good), your `skills/` directory, and any tunables you set by hand. What
does not: the connector URL (its hostname contains the Worker name), the
runner token, and the old database's command history (export it first if you
want it; step 2).

| Old | New |
|---|---|
| `runlet` command, `~/.local/bin/runlet` | `sasonica`, `~/.local/bin/sasonica` |
| `runlet.mjs` | `sasonica.mjs` |
| `RUNLET_*` settings and Worker secrets | `SASONICA_*` |
| `~/.config/runlet/` (`%APPDATA%\runlet\` on Windows) | `~/.config/sasonica/` (`%APPDATA%\sasonica\`) |
| `~/.local/state/runlet/` (`%LOCALAPPDATA%\runlet\`) | `~/.local/state/sasonica/` (`%LOCALAPPDATA%\sasonica\`) |
| `runlet.service` | `sasonica-shell.service` |
| launchd `org.runlet.runner` | `com.sasonica.shell` |
| Scheduled Task `runlet` | `sasonica-shell` |
| Worker and D1 `runlet-<site>` | `sasonica-shell-<site>` |
| MCP server `runlet` | `sasonica-shell` ("Sasonica Shell") |

Steps marked **DESTRUCTIVE** cannot be undone. Everything before step 8 can be
rolled back (see the end): the old Worker and database are untouched until
then.

**Do this from a terminal on the machine, not through the Runlet connector.**
Step 1 stops the runner, and systemd takes every command it started with it
-- including the one doing the migrating.

The commands are for Linux; macOS and Windows differences follow each step.
`<site>` is the site name from the old install, usually the hostname: it is
`RUNLET_SITE` in `~/.config/runlet/env`.

## 0. Before you start

- A Cloudflare API token with **Workers Scripts: Edit** and **D1: Edit** on the
  account (SETUP.md, section 2). Export it for the steps that call wrangler:

  ```bash
  export CLOUDFLARE_API_TOKEN=...
  export CLOUDFLARE_ACCOUNT_ID=$(sed -n 's/^CLOUDFLARE_ACCOUNT_ID=//p' ~/.config/runlet/env)
  ```

- Nothing running: `runlet status` should show no `running` rows you care
  about. A row still running when the runner stops is lost with it.

## 1. Stop and remove the old service

Stop it before updating the checkout: the old unit runs `runlet.mjs`, which the
update deletes, and `Restart=always` would then fail every ten seconds.

```bash
systemctl --user disable --now runlet
rm ~/.config/systemd/user/runlet.service
systemctl --user daemon-reload
```

macOS:

```bash
launchctl bootout "gui/$(id -u)/org.runlet.runner"
rm ~/Library/LaunchAgents/org.runlet.runner.plist
```

Windows (PowerShell):

```powershell
Stop-ScheduledTask runlet
Unregister-ScheduledTask runlet -Confirm:$false
```

From here until step 5 the machine runs no assistant commands at all.

## 2. Optional: keep the old history

The old database holds the command and result history for the last
`RUNLET_KEEP_DAYS` days. Step 8 deletes it. To keep a copy:

```bash
cd worker
npx wrangler d1 export runlet-<site> --remote --output ~/runlet-history.sql
cd ..
```

The file holds every command and its output. Keep it somewhere private, or
skip this step.

## 3. Update the checkout

```bash
git pull            # or check out the branch with the rename
```

If you want the folder renamed too (`~/projects/runlet` to
`~/projects/sasonica-shell`), do it now: the service is written with the
checkout's path in it at install time, so moving the folder afterwards breaks
it. The GitHub repository keeps the name `runlet` for now.

## 4. Move the config across

```bash
mv ~/.config/runlet ~/.config/sasonica
mv ~/.config/sasonica/env ~/.config/sasonica/env.runlet
rm -f ~/.config/sasonica/seen-nonces        # only present on very old installs
```

The old `env` is set aside, not renamed key by key. The installer reuses the
Worker name, database name and ids it finds in `env`; given
`SASONICA_WORKER_NAME=runlet-<site>` it would redeploy onto the old Worker
instead of creating the new one. With no `env`, it starts fresh under the new
names and keeps `relay.key` and `skills/`, which moved with the directory.

If the old install used a site name other than the hostname, say so to the
installer: `export SASONICA_SITE=<site>`.

Windows: move `%APPDATA%\runlet` to `%APPDATA%\sasonica` and rename `env` in it
to `env.runlet` the same way. Delete `%APPDATA%\sasonica\bin\runlet.cmd`, and
remove `%APPDATA%\runlet\bin` from your user `Path` (the installer adds the new
`bin`).

## 5. Install under the new name

```bash
./install.sh            # Windows: .\install.ps1
```

With the token from step 0 in the environment this asks nothing. It:

1. creates the D1 database `sasonica-shell-<site>` and applies `schema.sql`
   (the same table as before);
2. writes `worker/wrangler.jsonc` naming the Worker `sasonica-shell-<site>`;
3. sets the Worker's secrets `SASONICA_HMAC_KEY` (from the existing
   `relay.key`), `SASONICA_URL_SECRET` and `SASONICA_RUNNER_TOKEN` (both new);
4. deploys it, at `https://sasonica-shell-<site>.<subdomain>.workers.dev`;
5. writes `~/.config/sasonica/env` and the `sasonica` command;
6. runs the smoke test (queues `echo sasonica-ok`, runs it, reads it back);
7. installs and starts `sasonica-shell.service` (a LaunchAgent
   `com.sasonica.shell` on macOS, the Scheduled Task `sasonica-shell` on
   Windows);
8. prints the new connector URL.

A failure anywhere stops it with the reason; fix that and run it again, since
every step checks before it creates.

## 6. Carry over what you tuned

Anything you had set by hand in the old `env` goes into the new one under its
new name:

```bash
grep -E '^RUNLET_(POLL|CMD_TIMEOUT|MAX_OUTPUT|PARALLEL|BACKGROUND_MAX|DETACH_CHECK|PROGRESS_EVERY|KEEP_DAYS|LOAD_MAX|RUNNER_ID|SKILLS_DIR|SHELL|NONCE_FILE)=' \
  ~/.config/sasonica/env.runlet
```

Add each line you want to `~/.config/sasonica/env` with `RUNLET_` changed to
`SASONICA_`, removing the installer's own `SASONICA_POLL` and
`SASONICA_CMD_TIMEOUT` lines if you are replacing them. Most are picked up
within one poll; `SASONICA_DETACH_CHECK` and `SASONICA_RUNNER_ID` need
`systemctl --user restart sasonica-shell`.

Then check it:

```bash
sasonica status
sasonica skills
journalctl --user -u sasonica-shell -n 20
```

## 7. Point the assistants at the new URL

```bash
sasonica install --print-url
```

- **Claude.ai**: Settings, Connectors, Add custom connector, paste the URL, no
  authentication. Name it for the machine, e.g. "Sasonica Shell on red5". Then
  remove the old Runlet connector.
- **ChatGPT**: the same in its custom connector settings.
- Any project or custom instructions that say "Runlet" or `runlet skills`:
  change them to Sasonica Shell and `sasonica skills`. The tool descriptions
  themselves come from the Worker and are already new.

Run something harmless through the new connector (`hostname`) before going on.

## 8. Delete the old Worker and database (DESTRUCTIVE)

Only once step 7 works. This cannot be undone: the old connector URL stops
answering, and the old history is gone unless you exported it in step 2.

```bash
cd worker
npx wrangler delete runlet-<site>
npx wrangler d1 delete runlet-<site>
cd ..
```

Or in the Cloudflare dashboard: Workers & Pages, the `runlet-<site>` Worker,
Settings, Delete; then Storage & Databases, D1, `runlet-<site>`, Delete.

## 9. Clear up the leftovers (DESTRUCTIVE, low stakes)

```bash
rm ~/.config/sasonica/env.runlet     # the old URL secret and runner token
rm ~/.local/bin/runlet               # the old command
rm -rf ~/.local/state/runlet         # the old nonce history
```

macOS also: `rm -rf ~/Library/Logs/runlet`. Windows: delete
`%LOCALAPPDATA%\runlet` and `%APPDATA%\sasonica\env.runlet`.

The old nonce history is safe to drop: it only ever guarded rows in the old
database, and every nonce is a fresh random value, so nothing the new Worker
signs can collide with it.

## Rolling back

Up to step 8 the old stack is intact in Cloudflare. To go back:

1. `systemctl --user disable --now sasonica-shell` and remove
   `~/.config/systemd/user/sasonica-shell.service`.
2. Check out the last commit before the rename.
3. `mv ~/.config/sasonica ~/.config/runlet`, then
   `mv ~/.config/runlet/env.runlet ~/.config/runlet/env`.
4. `./install.sh`: it finds `runlet-<site>` from the restored `env`, keeps its
   secrets, and reinstalls `runlet.service`.
5. Delete the new `sasonica-shell-<site>` Worker and database the same way as
   step 8, if you do not mean to try again.
