# Two machines

Optional. Everything works on one machine. This describes what changes when you have a second
one — say a laptop you sit at and a desktop with a bigger GPU — and want agents to use both.

The idea is not "remote control". It is that a job runs where it fits: big unified-memory work on
the Mac, CUDA work on the box with the NVIDIA card, and long independent jobs on whichever
machine is currently idle.

## Reaching the other machine

`ssh peer` has to work without a password prompt, or nothing below is usable. Two ways:

- **Tailscale SSH** — both machines join the same tailnet, SSH is handled by Tailscale, and no
  key management is left. This is the shipped assumption: `ssh peer` just works, from either side.
- **Plain SSH keys** — works fine, you maintain the keys. Put the private key somewhere the
  agent can read it and never let it near a git repository.

Add a `Host peer` entry to `~/.ssh/config` on both machines so the name is symmetric: from A,
`peer` is B; from B, `peer` is A. Every tool below uses that name and nothing else.

## The tools for it

They are in `shell/`, so step 3 of [INSTALL.md](../INSTALL.md) has already put them on your
`PATH`. Each has a header comment saying what it does; this is the shape of the layer rather than
a catalogue of it, because a catalogue in prose is wrong by the next commit.

- **Before anything runs over there:** `check-resources` reports free VRAM and RAM, the processes
  holding the GPU, the models currently loaded, and the PROTECTED list. `--json` for a script.
  `run-on peer <command>` is the safe primitive built on it: it reads `check-resources` **on the
  target** and refuses a job that would displace a protected service or that plainly does not fit
  in free memory. It does not decide policy, it enforces the floor; `--force` overrides it once
  you have decided.
- **Work over there:** `wb-ssh-worker` opens a worker pane in the peer's tmux session,
  `wb-remote-view` attaches a grouped view session so those panes are visible in your own window,
  and `wb-shot-remote` takes a screenshot on the peer and brings the file back.
- **Keeping the two in step:** `wb-sync-setup` mirrors the setup itself, `vault-sync` commits and
  pushes the knowledge base, `status-freshness` says which project notes have gone stale.
- **Models:** `wb-modell-proxy` starts a local model server on first connection and shuts it down
  when it goes idle, so the second machine holds no weights while nobody is asking.

## The policy that matters more than the tooling

Checking free memory is mechanical. What to do when it is tight is not, and the agent roles are
deliberately conservative about it: look at what is loaded, and if something would have to be
stopped to make room, **ask the user** — never stop it yourself. Then, in order: run it on your own
machine instead, or use a smaller model, or say plainly that it does not fit. Killing someone
else's inference job to free VRAM is the failure mode this rule exists to prevent.

## Keeping state in sync

Two categories, two mechanisms, on purpose:

- **Code and notes**: git. The knowledge base is a private repository; both machines clone it.
- **Secrets and machine-local state**: never git. Syncthing peer-to-peer between the two
  machines, so an API key never reaches a hosting provider. Folders: the knowledge base's
  `90-secrets/` and a small `~/.secrets-sync/` holding API keys as mode-600 files.

## Sessions on the other machine

Orchestrator sessions and their workers run in one tmux session, your own commands in another —
so that watching agents work and typing commands do not fight over the same window. The
workbench opens both in separate tabs and attaches a grouped view session, which is what makes
remote workers visible locally at all.

That last part matters more than it sounds: workers running where nobody can see them is a
failure, not a detail. If you change the layout, verify afterwards that the panes are actually
on screen.

A tmux session that has to survive a reboot on the Linux side is a systemd user unit; there is a
template for it in [services/systemd/tmux-orch.service](services/systemd/tmux-orch.service).
