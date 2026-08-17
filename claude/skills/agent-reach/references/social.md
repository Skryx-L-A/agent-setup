# Social Media & Communities


## Twitter/X (twitter-cli)

### Authentication Prerequisites

The cookie saved via hidden input by `agent-reach configure twitter-cookies` is only used by
`agent-reach doctor` to check whether explicit credentials are complete. `doctor` does not run
the upstream `twitter status`, nor does it set anything in the current shell. Before running any
`twitter` command below, you must explicitly provide the following in the same shell or
subprocess environment:

```bash
export TWITTER_AUTH_TOKEN="..."
export TWITTER_CT0="..."
```

### Stable Commands

```bash
# Home timeline (most stable)
twitter feed -n 20

# Read a single tweet (including replies)
twitter tweet URL_OR_ID

# Read a long-form post / X Article
twitter article URL_OR_ID

# User timeline
twitter user-posts @username -n 20

# User profile
twitter user @username
```

### Potentially Unstable Commands

```bash
# Search tweets (Twitter frequently changes its GraphQL endpoints, may 404)
twitter search "query" -n 10

# likes (since 2024 only your own are visible — platform restriction)
twitter likes
```

### Retry Chain When `search` Fails (run in order, stop on first success)

1. Retry once directly (occasional failures are common): `twitter search "query" -n 10`
2. Upgrade, then retry: `pipx upgrade twitter-cli && twitter search "query" -n 10`
3. Switch to the OpenCLI fallback (desktop, reuses the browser login session): `opencli twitter search "query" -f yaml`
4. If none of that works, route around it with a stable command like `twitter feed` / `twitter user-posts @somebody`

### Important Notes

> **Install**: `pipx install twitter-cli` (make sure it's v0.8.5+)
>
> **Auth**: Only use manual Cookie-Editor export, then explicitly set the environment variables
> `TWITTER_AUTH_TOKEN` + `TWITTER_CT0`; don't rely on automatic browser reading.
>
> **IP risk control**: Don't call frequently from a VPS/datacenter IP, especially
> followers/following — risk of account suspension. Use a residential proxy or a local
> environment.
>
> **OpenCLI fallback**: If OpenCLI is installed on the desktop, the full
> `opencli twitter search/article/user-posts -f yaml` set works (browser login session, no
> cookie environment variables needed).
>
> **Output format**: Recommend `--yaml` or `--json` for structured output — friendlier for AI agents.

## Bilibili

> ⚠️ **Don't use yt-dlp to read Bilibili** (its anti-bot system now blanket-blocks with 412 —
> confirmed no workaround). Use bili-cli / OpenCLI instead.

```bash
# Search / trending / video details (bili-cli, read-only, no login needed)
bili search "query" --type video -n 5
bili hot -n 10
bili video BVxxx

# Subtitles (OpenCLI, requires desktop Chrome)
opencli bilibili subtitle BVxxx
```

> For detailed commands (audio transcription, direct API fallback) see [references/video.md](video.md).

## V2EX (public API)

No authentication required — call the public API directly.

### Trending Topics

```bash
curl -s "https://www.v2ex.com/api/topics/hot.json" -H "User-Agent: agent-reach/1.0"
```

### Node Topics

```bash
# node_name examples: python, tech, jobs, qna, programmers
curl -s "https://www.v2ex.com/api/topics/show.json?node_name=python&page=1" -H "User-Agent: agent-reach/1.0"
```

### Topic Details

```bash
# Get topic_id from the URL, e.g. https://www.v2ex.com/t/1234567
curl -s "https://www.v2ex.com/api/topics/show.json?id=TOPIC_ID" -H "User-Agent: agent-reach/1.0"
```

### Topic Replies

```bash
curl -s "https://www.v2ex.com/api/replies/show.json?topic_id=TOPIC_ID&page=1" -H "User-Agent: agent-reach/1.0"
```

### User Info

```bash
curl -s "https://www.v2ex.com/api/members/show.json?username=USERNAME" -H "User-Agent: agent-reach/1.0"
```

### Python Usage Example

```python
from agent_reach.channels.v2ex import V2EXChannel

ch = V2EXChannel()

# Get hot posts
topics = ch.get_hot_topics(limit=10)
for t in topics:
    print(f"[{t['node_title']}] {t['title']} ({t['replies']} replies)")

# Get node posts
node_topics = ch.get_node_topics("python", limit=5)

# Get topic details + replies
topic = ch.get_topic(1234567)
print(topic["title"], "—", topic["author"])

# Get user info
user = ch.get_user("Livid")
```

> **Node list**: https://www.v2ex.com/planes

## Reddit (multi-backend, login required)

**Reddit has no zero-config path**: the anonymous `.json` endpoints are blocked (403), and the
official API's manual review has largely stopped approving new applications since 2025-11. Both
backends depend on a login session — first run `agent-reach doctor --json` to see reddit's
`active_backend`. Access from mainland China requires a proxy.

### Backend A: OpenCLI (preferred on desktop, reuses the browser login session)

```bash
# Search posts
opencli reddit search "query" -f yaml

# Read full post text + comments
opencli reddit read POST_ID -f yaml

# Browse a subreddit / hot / popular
opencli reddit subreddit LocalLLaMA -f yaml
opencli reddit hot -f yaml
opencli reddit popular -f yaml

# Subreddit metadata (subscriber count, description)
opencli reddit subreddit-info LocalLLaMA -f yaml
```

> Requires Chrome to be open with reddit.com already logged in in the browser.

### Backend B: rdt-cli (legacy/server fallback, upstream unmaintained since 2026-03)

```bash
rdt search "query" --limit 10   # Search posts
rdt read POST_ID                # Read full post text + comments
rdt sub python --limit 20       # Browse a subreddit
rdt popular --limit 10          # Browse popular
rdt all --limit 10              # Browse /r/all
```

> **Install**: `pipx install 'git+https://github.com/public-clis/rdt-cli.git'` (the PyPI
> version lags behind — install v0.4.2+ from GitHub). You must `rdt login` before you can search
> and read (on a headless server, write the cookie manually — see the doctor hint).
> Recommend `--yaml` output — friendlier for AI agents.

### Advanced Option: Official API + PRAW (only for users who already have credentials)

Users who registered a Reddit script app before 2025-11 (holding a client_id/client_secret) can
use PRAW to go through the official API (100 QPM free). New applications require manual review
and personal projects are largely rejected — **don't recommend this path to new users**.

## Facebook (OpenCLI, login required)

Facebook goes through OpenCLI, reusing the facebook.com login session in the user's Chrome.
First run `agent-reach doctor --json` to check facebook's `active_backend`, which should
normally be `OpenCLI`. Don't recommend Jina/Exa/Graph API as the default path.

```bash
# Search users / pages / posts
opencli facebook search "query" -f yaml

# User or page info
opencli facebook profile zuck -f yaml

# Current account's News Feed
opencli facebook feed --limit 10 -f yaml

# Group list / recent activity visible to the current account
opencli facebook groups --limit 20 -f yaml
```

> Requires Chrome to be open with the OpenCLI extension installed and facebook.com already
> logged in. Facebook Groups currently only guarantees reading the group list/recent activity
> visible to the current account — it does not guarantee an API for arbitrary group posts and
> comments.

## Instagram (OpenCLI, login required)

Instagram goes through OpenCLI, reusing the instagram.com login session in the user's Chrome.
First run `agent-reach doctor --json` to check instagram's `active_backend`, which should
normally be `OpenCLI`. Don't default back to instaloader — it has a history of cookie/401/429
instability.

```bash
# Search users (not a site-wide post keyword search)
opencli instagram search "query" -f yaml

# User profile
opencli instagram profile nasa -f yaml

# User's recent posts
opencli instagram user nasa --limit 12 -f yaml

# Explore / Discover
opencli instagram explore --limit 20 -f yaml

# Current account's saved items
opencli instagram saved --limit 20 -f yaml
```

> Requires Chrome to be open with the OpenCLI extension installed and instagram.com already
> logged in. `instagram search` is a user search; to read posts you must first determine the
> username, then use `instagram user USERNAME`. If you get 429 / login required, have the user
> log back in via Chrome first and reduce the request frequency.
