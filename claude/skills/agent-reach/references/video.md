# Video / Podcasts

Subtitles and transcripts for YouTube and Bilibili.

## YouTube (yt-dlp)

### Get video metadata

```bash
yt-dlp --dump-json "URL"
```

### Download subtitles

```bash
# Download subtitles (no video)
yt-dlp --write-sub --write-auto-sub --sub-lang "zh-Hans,zh,en" --skip-download -o "/tmp/%(id)s" "URL"

# Then read the .vtt file
cat /tmp/VIDEO_ID.*.vtt
```

### Get comments

```bash
# Extract comments (best-effort, not guaranteed complete)
yt-dlp --write-comments --skip-download --write-info-json \
  --extractor-args "youtube:max_comments=20" \
  -o "/tmp/%(id)s" "URL"
# Comments are in the .info.json file's comments field
```

### Search videos

```bash
yt-dlp --dump-json "ytsearch5:query"
```

> **Subtitle note**: Manually uploaded subtitles extract reliably; auto-generated subtitles may
> have duplicate lines that need post-processing.
> **Comment note**: `--write-comments` is based on web scraping (not the YouTube Data API), so
> some comments may be missing.

### Retry Chain When Subtitles Fail (run in order, stop once you get real content)

`doctor` only confirms that yt-dlp itself and the JS runtime can execute — it doesn't request a
specific video; so `active_backend: yt-dlp` does not mean the target video's subtitles have
actually passed live verification.

1. First try the `yt-dlp --write-sub --write-auto-sub` command above.
2. If bot verification appears, the subtitle response is empty, or no subtitle file is
   generated, and OpenCLI is connected: `opencli youtube transcript "URL" -f yaml`.
3. If OpenCLI returns `Caption URL returned empty response`, retry up to 3 times — this is an
   occasional expiry of the time-limited subtitle URL, not proof that "the video has no
   subtitles."
4. If it still fails, or the video genuinely has no subtitles: `agent-reach transcribe "URL"` to
   download the audio and transcribe it.

Success means actually getting non-empty subtitle/transcript content, not the command's exit
code or `doctor`'s version-probe result.

### No-Subtitle Fallback: Whisper Audio Transcription

```bash
# Fallback when a video has no subtitles: download the audio and transcribe with Whisper (a free Groq key is enough)
agent-reach transcribe "https://www.youtube.com/watch?v=VIDEO_ID"
agent-reach transcribe ./local_audio.mp3 -o /tmp/transcript.txt
```

> `agent-reach transcribe` only accepts a public http(s) URL or a local audio file. When
> searching with `ytsearch5:`, first pick a specific video URL out of the yt-dlp results, then
> transcribe it.
> You need to configure a key first: `agent-reach configure groq-key` (hidden input; free,
> console.groq.com) or `agent-reach configure openai-key`. The default auto mode only uses the
> first configured provider (Groq preferred, otherwise OpenAI); on failure it stops rather than
> automatically sending the audio to the other provider.
> `--allow-provider-fallback` explicitly authorizes cross-provider degradation; the same audio
> content may then be processed by both Groq and OpenAI separately, potentially incurring OpenAI
> costs — only use this once you've confirmed the content can be shared with both providers.

## Bilibili (bili-cli primary, OpenCLI for subtitles)

> ⚠️ **Don't use yt-dlp to read Bilibili**: Bilibili's anti-bot system now blanket-blocks yt-dlp
> with 412 (confirmed the latest version fails whether direct, via proxy, or with cookies).
> yt-dlp is for YouTube only.

### Video details / search / trending / rankings (bili-cli, read-only, no login needed)

```bash
# Video details (title / uploader / duration / view & engagement data / subtitle availability)
bili video BVxxx

# Search videos
bili search "query" --type video -n 5

# Trending videos / rankings
bili hot -n 10
bili rank -n 10

# Download audio and split it into ASR-ready WAV (pair with agent-reach transcribe when there are no subtitles)
bili audio BVxxx
```

### Subtitles (OpenCLI, requires desktop Chrome)

```bash
# Subtitles, sentence by sentence with timestamps
opencli bilibili subtitle BVxxx

# OpenCLI can also search / read video metadata (fallback)
opencli bilibili search "query" -f yaml
opencli bilibili video BVxxx -f yaml
```

### Zero-Config Fallback: Direct Search API

```bash
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
curl -s -c /tmp/bili_ck.txt -o /dev/null -A "$UA" "https://www.bilibili.com/"
curl -s -b /tmp/bili_ck.txt -A "$UA" -e "https://www.bilibili.com/" \
  "https://api.bilibili.com/x/web-interface/search/all/v2?keyword=QUERY&page=1"
```

> **Installing bili-cli**: `pipx install bilibili-cli` (upstream unmaintained since 2026-03 but
> confirmed healthy; read-only use needs no login — `bili login` via QR code unlocks personal
> features like moments/favorites).

## Selection Guide

| Scenario | Recommended tool |
|-----|---------|
| YouTube subtitles | yt-dlp; on failure, OpenCLI (up to 3 times) → agent-reach transcribe |
| Bilibili video details/search | bili-cli |
| Bilibili subtitles | opencli bilibili subtitle |
| Audio/video without subtitles | agent-reach transcribe (for Bilibili audio, run `bili audio` first) |
