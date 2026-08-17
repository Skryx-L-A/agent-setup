# Background services

Nothing here is required. The workbench runs without a single one of them; each solves a specific
problem that only appears once you use it daily. `install.sh` deliberately loads none of them —
starting a background job on someone's machine is a decision, and it stays yours.

## The templates

They are in `docs/services/`, launchd for macOS and systemd user units for Linux. Two placeholders
have to be replaced before a template is loaded: `__HOME__` for your home directory and `__USER__`
for your login name. Not every file contains both; the substitution below is the same either way
and does no harm where there is nothing to replace.

| Template | Problem it solves |
|---|---|
| `launchd/agent-workbench.mcp-basic-memory.plist` | MCP servers started per session pile up. Measured on a working machine: 21 processes holding 3.7 GB for this one tool alone. One shared server over HTTP on localhost instead. Needs the `basic-memory` command, which is not part of this repository. |
| `launchd/agent-workbench.mcp-playwright.plist` | The same, for the browser MCP: 51 processes, 3.0 GB. Runs headless and isolated, so a shared server never opens a window in front of you. |
| `launchd/agent-workbench.mcp-reaper.plist` | Ends the MCP helpers whose session died. A clean exit tidies up after itself; a crash or a hard-closed pane leaves 100 to 200 MB standing per orphan. |
| `launchd/agent-workbench.limit-survivor.plist` | When an agent hits its rate limit the pane stops and stays stopped. This reads the reset time out of the message and nudges it back to work once that time has passed — not before, not repeatedly. |
| `launchd/agent-workbench.brain-backup.plist` | Bundles the knowledge base weekly, so a bad git day is not a lost brain. |
| `launchd/homebrew.mxcl.ollama.plist` | The local model server. Replaces the file Homebrew writes, and differs from it in the environment block only — without `OLLAMA_CONTEXT_LENGTH` every local model silently serves a fraction of its real context. |
| `systemd/tmux-orch.service` | Keeps a lead tmux session alive across reboots on a Linux machine, so the other machine can always reach it. |
| `systemd/agent-workbench-brain-backup.service` + `.timer` | The Linux counterpart of the backup job. |

## macOS

```bash
sed -e "s|__HOME__|$HOME|g" -e "s|__USER__|$(id -un)|g" \
    docs/services/launchd/agent-workbench.mcp-basic-memory.plist \
    > ~/Library/LaunchAgents/agent-workbench.mcp-basic-memory.plist
launchctl load ~/Library/LaunchAgents/agent-workbench.mcp-basic-memory.plist
launchctl list | grep agent-workbench        # verify it is actually running
```

To stop one: `launchctl unload <plist>`. Changing a plist means unload, edit, load — a running
agent does not re-read its file.

## Linux

The same jobs are systemd **user** units (`systemctl --user`), not system units: they belong to
your session and need no root.

```bash
mkdir -p ~/.config/systemd/user
sed -e "s|__HOME__|$HOME|g" -e "s|__USER__|$(id -un)|g" \
    docs/services/systemd/agent-workbench-brain-backup.service \
    > ~/.config/systemd/user/agent-workbench-brain-backup.service
cp docs/services/systemd/agent-workbench-brain-backup.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now agent-workbench-brain-backup.timer
systemctl --user list-timers agent-workbench-brain-backup.timer
```

A macOS template with no Linux counterpart translates mechanically: the plist names the command
and the interval, and that is all a `.service` plus `.timer` pair needs.

## The property lists in `shell/`

`shell/` carries two more launchd jobs that belong to tools in this repository rather than to the
optional layer: the model proxy and the session sweep. They are real files from a working machine
rather than templates, so they do not carry `__HOME__` — they carry a literal `$HOME`, which
launchd does **not** expand. Run the same `sed` over them, with `$HOME` as the pattern, before you
load either one:

```bash
sed "s|\$HOME|$HOME|g" shell/agent-workbench.modell-proxy.plist \
    > ~/Library/LaunchAgents/agent-workbench.modell-proxy.plist
```

The comment at the top of each file says what it expects to be installed first.

## Services that must never be stopped

An inference server holding a model resident, a live consumer, anything whose death would be
noticed: `check-resources` reports such a process as PROTECTED, and the agent rules forbid stopping
one without asking. The shipped version of `check-resources` carries the entry from the machine it
grew on — search the script for `PROTECTED` and put your own there. An empty list is a valid
answer; a wrong one is not, because an agent that believes nothing is protected will free memory
the direct way.
