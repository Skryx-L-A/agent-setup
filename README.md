# agent-setup

A desktop workbench for running coding agents side by side. One lead session plans and verifies,
several worker panes do the work in parallel, and the machinery around them keeps that from
falling apart: a context guard, a result protocol, hooks that block the mistakes agents actually
make, and a model registry that treats every harness as data instead of a code branch.

The window is an Electron program that drives tmux over its control mode. Everything it shows —
sessions, worker panes, output, the editor, the chat stage — is a live view on real tmux panes,
so the same work is reachable from a terminal on the same machine or over SSH from another one.

It is not tied to one vendor. Claude Code, Codex, aider, opencode and local models via Ollama are
entries in a JSON registry. A setup with no account at all is a supported path: Ollama plus the
local worker lane runs entirely on your own hardware.

## This repository is the whole setup

The program plus everything that grew around it: the agent rules, the skills, the hooks, the
knowledge base, the configuration for local workers. If you only want the window and the worker
machinery and intend to bring your own agent configuration, take
**[agent-workbench](https://github.com/Skryx-L-A/agent-workbench)** instead. Both
repositories are built from the same private source tree by the same script, so they never drift
apart.

## What is in here

Every number below is counted at build time, not written down. A hand-kept inventory is right
until the next commit, and this one has been wrong three times already.

```
app/         the workbench itself — Electron main process, preload bridges, renderer, and
             awb-ctl, a dependency-free CLI that talks to the running program over a socket
extension/   16 modules the app imports rather than duplicates. They started life in a
             VS Code extension and still carry its directory name; there is exactly one copy
             of each, and this is it
shell/       97 command-line tools and the default configuration files they read:
             worker spawners, context guard, model registry, session management, budget and
             quota, cross-machine helpers, local media generation, knowledge-base maintenance.
             shell/linux/ holds the variants that need CUDA instead of Apple Silicon
claude/      what an agent reads before it starts — two role prompts, 12 rule files,
             16 skills, 18 hooks, and templates for CLAUDE.md and settings.json
pi/          the configuration for local workers: the two role files the local harness reads,
             its model list, and a template for the instruction file it generates
knowledge/   an empty knowledge-base skeleton: branch layout, note templates, and the tooling
             that indexes and searches it. The notes are yours; none ship here
docs/        4 reference documents for the optional layers, plus 9 service
             templates under docs/services/
beispiele/   3 worked examples — a project rule file, a note written to the
             template, and an AGENTS.md for a harness that reads that filename instead
tmux.conf    the pane borders, the keybindings, the right-click menu, and the hook that
             brings a pane back after the system killed it
install.sh   the mechanical half of the installation: five copies, a snapshot before every
             overwrite, and a count at the end
INSTALL.md   how to put all of it on your machine
```

## What you have after installing

- **A workbench window** with your sessions on one side and every worker pane visible at once.
- **Workers you spawn by name and model.** `claude-worker review sonnet5:high ~/project "…"`
  opens a pane, waits until the harness is genuinely ready, types the task, and checks that it
  was submitted. The same name later means the same pane with the same context.
- **A context guard** that watches how full each pane's context is, makes a worker write a
  handoff before it runs out, compacts it, and sends it back to work. Nothing can compact
  itself, and an agent with a full context does not fail loudly — it quietly gets worse.
- **A result protocol.** Every worker writes its outcome to a file, and you wait on the file
  rather than on what the pane looks like. A spinner is not a status.
- **A model registry.** Harnesses, providers and models are JSON. `wb-state models discover`
  imports whatever your installed CLIs currently offer, so a model you just pulled shows up on
  its own.
- **Hooks that refuse.** A secret on a command line, a `pkill` pattern wide enough to hit
  someone else's process, a commit nobody asked for, a screenshot of a live window — each is
  blocked at the point where it would happen.
- **A knowledge base skeleton.** Structure, templates and tooling, empty.
- **The side lanes the agent rules assume.** Local image, speech and video generation, so an agent
  that needs a picture does not reach for a paid API; `brain`, `vault-sync`, `status-freshness`
  and `brain-maintain` for the knowledge base; `claude-md-lint` and `wb-consistency` for the rules
  themselves. Each needs something installed first — the two documents below say what.

## Optional layers

None of these is needed to start. Each has one document that says what it does and what it costs:

- [docs/CROSS-MACHINE.md](docs/CROSS-MACHINE.md) — a second machine, and how a job ends up on the
  one it fits.
- [docs/DESIGN.md](docs/DESIGN.md) — the four design skills, and the A/B test that shaped them.
- [docs/MEDIA.md](docs/MEDIA.md) — generating images, speech and video locally instead of through
  a paid API.
- [docs/SERVICES.md](docs/SERVICES.md) — the background jobs, with templates in `docs/services/`.

One more layer lives outside this repository: **project-kit** turns "new project" into a finished,
scaffolded folder — it grills the plan to a definition of ready, then generates the structure, the
memory and the project's own sub-agents. It is a public repository under the same account as this
one, and it installs as a Claude Code plugin in two lines:

```
/plugin marketplace add <your-github-user>/project-kit
/plugin install project-kit@project-kit
```

Nothing here depends on it, and it does not depend on anything here.

> `<your-github-user>` appears wherever a repository address does. It is a placeholder on purpose:
> the tool that extracts this repository from a working machine removes account names everywhere,
> and it cannot tell the account in a public URL from the one on the machine. Put in the account
> this repository is hosted under — the address bar you cloned from shows it.

## Requirements

| Needed | Why |
|---|---|
| git, tmux, python3 | the tools are built on them |
| Node.js 22 or newer | the workbench is an Electron program and is built from source |
| At least one agent CLI | otherwise there is nothing to orchestrate |
| A subscription or API key | only for cloud harnesses |
| Ollama and a local model | only for the local lane — roughly 6 GB for a small model |
| WSL2 on Windows | tmux has no native Windows equivalent |

## Honest limitations

- **The role prompts, rules and code comments are in German.** They work as they are, but if you
  do not read German you will want to translate `claude/roles/` and `claude/regeln/` first. Any
  agent does that in one pass.
- **Some tools describe a two-machine setup that is not yours.** `wb-sync-setup`,
  `wb-shot-remote`, `wb-remote-view`, `peer-connect` and `wb-ssh-worker` assume a second host
  reachable over SSH, and `wb-modell-proxy` assumes a local model server on it. They are inert
  without one, and the hostnames in them are placeholders you have to fill in.
  [docs/CROSS-MACHINE.md](docs/CROSS-MACHINE.md) has the rest.
- **Some tools are wrappers around programs that are not here.** `docrender` and `slop-detect`
  are four lines each and call projects with their own repositories; `medien-ui`, `bild`, `video`,
  `tts` and `stt` need model weights measured in gigabytes. The wrapper tells you the path it
  expects, and the skills that use them work without them and say so —
  [docs/MEDIA.md](docs/MEDIA.md) and [docs/DESIGN.md](docs/DESIGN.md) say what to install.
- **The two launchd files in `shell/` are real files, not templates.** They come from a working
  machine and carry a literal `$HOME`, which launchd does not expand — substitute it before you
  load either one. The templates that are ready to use are in `docs/services/`, with `__HOME__`
  and `__USER__` to replace.
- **The registry ships with the harnesses that were actually measured** on macOS and Linux. A
  harness you add yourself needs its ready pattern measured once with `wb-harness-probe` —
  a guessed pattern produces workers that receive nothing and never say so.
- **Windows is untested.** The tools assume a POSIX shell and tmux; WSL2 is the path, and nobody
  has walked it end to end.
- **Three things are deliberately missing, all for the same reason.** One rule file in
  `claude/regeln/` was an inventory of the tools on one machine, and it named which credential
  store each tool reads and where its configuration lives. The two tools that send mail did the
  same, except that their account names stand in the file as values rather than as a description.
  Where and in what form credentials are kept is precisely what should never be written down for
  strangers, so all three stay out. The mail path is installation-specific anyway — which
  provider, which store, which account is different for everyone — so write your own; the role
  prompts still describe when an agent may send at all. Any text in here that names a tool this
  clone does not carry says so at the end of the file, added while this repository was built.
- **No telemetry, no phone-home, no bundled credentials.** There are no keys and no personal data
  in this repository. It is mechanics only.
- **The knowledge harvester reads your private transcripts, by design.** `knowledge/_meta/tools/`
  contains a harvesting pipeline that mines agent sessions for durable facts, and to do that it
  reads `~/.claude/projects/*.jsonl`, `~/.pi-workers/results/` and your project directories.
  Everything stays on your machine and nothing is sent anywhere, but you should know this before
  you start it rather than after. Its secret gate can be given extra patterns of your own —
  see the note below.

## Two files you should create before the first harvest

Neither is shipped, both are read from outside any repository, and both exist for the same reason:
a list of personal patterns is itself personal data, so it can never live next to the code that
uses it.

- `~/.config/gardener-dream/secret-patterns.local.json` — extra secret patterns for the harvester's
  gate. It already knows the common provider prefixes, private keys, JWTs and
  `password = <value>`-style assignments; what it cannot know are the shapes that only occur in
  your world. Template with the full explanation:
  `knowledge/_meta/tools/gardener/secret-patterns.local.json.example`. Without the file the gate
  runs with its built-in list, which is not an error and is not reported — which is exactly why
  this paragraph exists.
- `~/.config/agent-workbench/depersonalize.rules` — only needed if you ever publish an extract of
  your own setup. The publishing gate that produced this repository lives in the private source
  tree, not here, and it reads its replacement table from that path.

## Getting started

Read [INSTALL.md](INSTALL.md). Handing that file to a coding agent and telling it to work through
the steps is a reasonable way to do it, and it is how the setup is meant to spread.

## License

MIT. See [LICENSE](LICENSE).
