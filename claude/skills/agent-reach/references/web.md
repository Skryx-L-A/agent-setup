# Web Reading

General web pages, RSS.

## General Web Pages (Jina Reader)

```bash
# Read any web page's content
curl -s "https://r.jina.ai/URL"

# Example
curl -s "https://r.jina.ai/https://example.com/article"
```

**Use case**: Most web pages can be read directly with Jina Reader.

## Web Reader (MCP)

```bash
# Read web page content (Markdown format)
mcporter call web-reader.webReader url="https://example.com"

# Retain images
mcporter call web-reader.webReader url="https://example.com" retain_images=true

# Plain-text format
mcporter call web-reader.webReader url="https://example.com" return_format="text"
```

**Use case**: When you need more precise control over the output format.

## RSS (feedparser)

```python
python3 -c "
import feedparser
for e in feedparser.parse('FEED_URL').entries[:5]:
    print(f'{e.title} — {e.link}')
"
```

**Use case**: Subscribing to blogs, news feeds, podcasts, and other RSS feeds.

## Selection Guide

| Scenario | Recommended tool |
|-----|---------|
| General web pages | Jina Reader (`curl r.jina.ai`) |
| Need images / format control | web-reader MCP |
| RSS subscriptions | feedparser |
