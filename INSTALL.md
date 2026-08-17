# Installing the setup

Roughly twenty minutes, most of it `npm ci`. Every step is repeatable: running it twice does the
same thing as running it once.

If you would rather not do it by hand, hand this file to a coding agent and tell it to work
through the steps. That is the intended path, and the last section says what to check afterwards.

## Getting to an agent

You need one agent CLI with an account behind it. Claude Code is what the role prompts and hooks
were written against, and there are three ways to it. All three work with this setup unchanged.

**Your own subscription (Pro or Max).** Start `claude`, it opens a browser, you sign in with your
Claude.ai account. Done. The free Claude.ai account is not enough for Claude Code — it takes Pro,
Max, Team, Enterprise or a Console account.

**A seat in a team or enterprise plan.** Someone with admin rights invites you in the team
dashboard, you accept and start `claude` — the same browser sign-in, with the invited account.
Nothing about the setup changes; the billing runs through the plan.

**An API key, the Console, or a cloud provider.** Sign in with your Console credentials, or set a
key: `export ANTHROPIC_API_KEY=…`. When several credentials are present, the order that decides is
cloud provider, then `ANTHROPIC_AUTH_TOKEN`, then `ANTHROPIC_API_KEY`, then `apiKeyHelper`, then
`CLAUDE_CODE_OAUTH_TOKEN`, then the subscription login. For Amazon Bedrock, Google Vertex or
Microsoft Foundry set `CLAUDE_CODE_USE_BEDROCK=1`, `CLAUDE_CODE_USE_VERTEX=1` or
`CLAUDE_CODE_USE_FOUNDRY=1` plus that provider's credentials; no browser sign-in is involved. For
CI and scripts, `claude setup-token` produces a long-lived OAuth token for
`CLAUDE_CODE_OAUTH_TOKEN`, which presupposes a subscription.

Do not set an API key on top of a subscription you want to use: the key wins, and the result is an
authentication error that looks like something else. `/status` inside Claude Code shows which way
is currently active. None of these values belongs in a repository, in a dotfile inside one, or in
a knowledge-base note outside `90-secrets/`.

A setup with no cloud account at all is a supported path: Ollama plus the local worker lane runs
entirely on your own hardware, and the model registry treats both the same way.

## 0. What has to be there first

```bash
# macOS
brew install git tmux node python@3.12 ripgrep rsync

# Debian / Ubuntu / WSL2
sudo apt install git tmux nodejs npm python3 ripgrep rsync
```

Node has to be version 22 or newer — `node -v` says which one you have. On Debian the packaged
Node is often older; use [nodesource](https://github.com/nodesource/distributions) or `nvm` then.

## 1. Get the repository

```bash
git clone https://github.com/Skryx-L-A/agent-setup.git ~/agent-setup
cd ~/agent-setup
```

Any directory works. The tools do not care where the checkout lives. `<your-github-user>` stands
for the account this repository is hosted under: the tool that extracts it from a working machine
removes account names everywhere and cannot tell a public URL from a private path.

## 2. Build the workbench

```bash
cd app
npm ci
npm run build
npm start          # the window opens
```

`npm run check` runs the type check and the build together — use that one when you change
something. On macOS you can also turn the program into a real application bundle, so that
Spotlight, the Dock and a double-click in the Finder start it:

```bash
./tools/buendel-bauen.sh
```

The bundle does not copy the source. It points at this directory, so a plain `npm run build` is
enough to update it; the bundle itself only has to be rebuilt when Electron changes.

## 3. Put everything in place

```bash
cd ~/agent-setup
./install.sh --trocken     # says what would change, writes nothing
./install.sh
```

Five copies: `shell/` to `~/.local/bin`, `claude/` to `~/.claude`, `pi/` to `~/.pi`, `knowledge/`
to `~/Knowledge`, and `tmux.conf` to `~/.tmux.conf`. Anything it replaces is copied to
`~/.local/trash-snapshots/<date>-install/` first, so a file of your own that happened to be in the
way is recoverable — **if you already have a `~/.tmux.conf`, that is the one to look at**: it was
replaced whole, not merged, and the two have to be reconciled by hand.

At the end the script counts the files that lie in the repository against the files that arrived,
compares them byte for byte, and reports any that did not make it. It installs no software, edits
no shell profile and loads no background service. A missing prerequisite ends the run with the
name of what is missing.

Make sure `~/.local/bin` is on your `PATH`. In `~/.zshrc` or `~/.bashrc`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

**By hand instead**, if you would rather see each step:

```bash
mkdir -p ~/.local/bin ~/.claude/workbench ~/.pi/agent
cp -a shell/. ~/.local/bin/
# cp -a carries the mode over. If it was lost on the way (a zip download does that),
# restore it from what the repository itself says is executable — never from a list:
(cd shell && find . -type f -perm +111 -exec chmod +x "$HOME/.local/bin/{}" \;)
cp -a claude/roles claude/regeln claude/skills claude/hooks claude/commands ~/.claude/
cp    claude/statusline-command.sh ~/.claude/
chmod +x ~/.claude/hooks/*.sh ~/.claude/hooks/*.py ~/.claude/statusline-command.sh
cp -a pi/agent/. ~/.pi/agent/
cp    tmux.conf ~/.tmux.conf
cp -a knowledge ~/Knowledge
```

Copy the whole of `shell/`, not only the executables: `wb-harness-config` looks for its templates
next to itself, and without them two harnesses fail to start with no useful message.

The execute bit matters. A hook without it does not fail loudly — it fails silently, and you find
out weeks later that nothing was ever blocked.

## 4. The files that are yours to fill in

Three templates were copied but not activated, because each one carries agreements rather than
machinery:

```bash
cp claude/CLAUDE.md.template     ~/.claude/CLAUDE.md
cp claude/settings.json.template ~/.claude/settings.json
```

`CLAUDE.md` is the contract every agent reads. The template is a scaffold: it has the sections and
says what belongs in each, and the placeholders in angle brackets are yours to replace. Read it
once from top to bottom before you start — a rule you did not mean is worse than a missing one.

`settings.json` wires the hooks to the events they run on. It is copied as it is used, so the
paths in it are `$HOME`-relative; if you keep your setup somewhere else, adjust them there.

The third is `~/.pi/agent/RULES.md.template`, the instruction file for the local worker lane. Do
not fill that one in by hand — it is generated from the two files above once they say what you
mean:

```bash
wb-instructions sync
```

That writes one instruction file per harness that does not read `~/.claude` on its own, each with
a checksum header, so a later `sync` is a no-op when nothing changed and refuses to overwrite a
file you edited yourself.

While you are in `~/.pi/agent/`: `models.json` and `settings.json` list the local models of the
machine this came from, and one of them points at a path under `$HOME` that only exists there.
Replace them with what `ollama list` actually gives you.

## 5. Install the model registry

```bash
cp shell/models.default.json ~/.claude/workbench/models.json
wb-state models discover --all
wb-harness-config apply
```

`discover` asks the CLIs you actually have installed what they currently offer and writes the
result into the registry, so a model you pull tomorrow shows up without an edit. `apply` writes
the config files that some harnesses cannot start without.

Check what came out:

```bash
wb-state models table
```

## 6. The knowledge base, if you want one

The workbench runs without it, and `install.sh` has already put the empty skeleton in `~/Knowledge`.
To make it a repository of your own:

```bash
cd ~/Knowledge
git init
cp IDENTITY.md.example IDENTITY.md    # fill in, never commit
```

The tooling under `_meta/tools/` is Python and uses [uv](https://docs.astral.sh/uv/):

```bash
cd ~/Knowledge/_meta/tools/braincli && uv sync
cd ~/Knowledge/_meta/tools/gardener && uv sync
```

Both build their index on first run; nothing is shipped pre-built. The gardener talks to a local
Ollama for embeddings and for its judging passes, so `ollama serve` has to be running and a model
pulled before its first run.

`beispiele/notiz.md` shows what a finished note looks like, written to `_meta/templates/note.md`.

## 7. Optional: project-kit

A separate public repository that turns "new project" into a finished, scaffolded folder. It is
independent of this setup in both directions, and it installs as a Claude Code plugin:

```
/plugin marketplace add <your-github-user>/project-kit
/plugin install project-kit@project-kit
```

## 8. Check that it worked

`install.sh` runs this for you at the end; run it again whenever something feels wrong.

```bash
wb-doctor
```

It prints one line per check and exits non-zero if something is wrong. Then start one worker and
watch it arrive:

```bash
tmux new -s work
claude-worker probe sonnet5 ~/agent-setup "Sag Hallo und beende dich."
```

The pane opens, the tool waits until the harness is genuinely ready, types the task and confirms
that it was submitted. If it reports that it never became ready, the harness's ready pattern does
not fit your version — measure it once with `wb-harness-probe` and put the result in the registry.
A guessed pattern produces workers that receive nothing and never say so.

## Where things end up

| Path | What |
|---|---|
| `~/.local/bin/` | the command-line tools |
| `~/.claude/` | roles, rules, skills, hooks, `CLAUDE.md`, `settings.json` |
| `~/.claude/workbench/models.json` | the model registry |
| `~/.pi/agent/` | the local worker lane's roles and model list |
| `~/.tmux.conf` | pane layout, keybindings, the revive hooks |
| `~/Knowledge/` | the knowledge base, if you installed it |
| `~/.config/agent-workbench/` | the workbench window's own state |
| `~/.local/trash-snapshots/` | whatever `install.sh` replaced |

## If you have a second machine

`wb-sync-setup`, `wb-ssh-worker`, `wb-remote-view` and `wb-shot-remote` expect a second host
reachable over SSH with the same layout. The hostnames in them are placeholders — open each one and
put your own in before you rely on it. Without a second host they simply do nothing, and nothing
else in the workbench depends on them. [docs/CROSS-MACHINE.md](docs/CROSS-MACHINE.md) has the rest,
including the two commands it mentions that are deliberately not in this repository.

## Background services

All optional, none of them loaded by `install.sh`. The templates are in `docs/services/`, launchd
for macOS and systemd user units for Linux, with `__HOME__` and `__USER__` to replace before you
load one. [docs/SERVICES.md](docs/SERVICES.md) says what each one is for and carries the
substitution command.

Two more launchd files sit in `shell/` next to the tools they belong to, the model proxy and the
session sweep. Those are real files rather than templates and carry a literal `$HOME`, which
launchd does not expand — substitute it the same way before loading.

## What is not here

Sending mail. Two tools did that in the setup this came from, and both name the account and the
place their credentials live — as values in the file, not as a description — so neither is
shipped. The rule that governs sending survives in the role prompts and in `CLAUDE.md.template`:
an agent drafts, a person releases. Wire your own sender to that rule and nothing else changes.

Beyond that, several tools here are wrappers around programs with their own repositories or with
model weights measured in gigabytes. They tell you the path they expect when they cannot find it;
[docs/MEDIA.md](docs/MEDIA.md) and [docs/DESIGN.md](docs/DESIGN.md) say what to install.

Any file in this repository that mentions a tool it does not carry says so in a note at the end,
added while the repository was built. Nothing has to be cross-checked by hand.
