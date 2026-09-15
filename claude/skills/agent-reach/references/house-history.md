## House notes (not upstream)

- Installed 2026-08-13 from a reviewed clone of `Panniantong/Agent-Reach` at
  commit `93ae1d1`, via `uv tool install`. CLI lives in the `uv` tool
  environment; `agent-reach` is on PATH. The reviewed clone stays at
  `~/.agent-reach/src/agent-reach`, branch `house`, so an update is a merge
  against this fassung instead of an overwrite.
- This SKILL.md and the references are the local English fassung. **`agent-reach
  skill --install` overwrites both**, so the fassung is kept outside the skill
  directory and restored automatically:
  - `~/.agent-reach/house-skin/` holds the authoritative copy plus checksums.
  - `agent-reach-skin apply|verify|capture` writes it back into all three places
    a copy lives: the skill directory, the installed package inside the uv tool
    environment, and the local clone.
  - A `PostToolUse`/Bash hook (`~/.claude/hooks/posttooluse-agent-reach-skin.sh`)
    runs `apply` after any command mentioning `agent-reach` or `skills add`.
    Verified by overwriting SKILL.md with the Chinese original — it came back.
  - After editing this file on purpose, run `agent-reach-skin capture`, otherwise
    the hook restores the older fassung.
  - The Chinese originals are kept in
    `~/.local/trash-snapshots/2026-08-13-agent-reach-references-zh/`.

### Channel status on this machine (measured 2026-08-13, not guessed)

Working, each confirmed with a real query rather than a doctor verdict:

| Channel | Path |
|---|---|
| Web full text | Jina Reader over `curl` |
| Web search | Exa via `mcporter` (`mcporter call exa.web_search_exa`) |
| GitHub | `gh search` |
| YouTube | `yt-dlp` subtitles |
| V2EX, RSS | public APIs |
| Bilibili | `bili-cli` |
| Reddit, Facebook, Twitter/X, Instagram | OpenCLI browser bridge |
| LinkedIn | `mcporter call linkedin.*`, profile in `~/.linkedin-mcp/profile` |

- The OpenCLI bridge is the Chrome extension on this Mac talking to a local
  daemon; it uses the sessions already logged in there. Instagram runs on the
  project account `<projekt-konto>`, not
  on a private one.
- **`agent-reach doctor` undercounts** — it reported 5/15 while eight channels
  answered real queries. It deliberately skips live probes for login-backed
  platforms, so its verdict is a floor, not the truth. Run the platform's own
  read command before believing a channel is missing.
