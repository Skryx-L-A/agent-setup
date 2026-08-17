# Search Tools

Exa AI search engine.

## Exa AI Search

A high-quality AI search engine, good for finding technical docs, official examples, and related web pages.

```bash
mcporter call exa.web_search_exa query="query" numResults=5
mcporter call exa.web_search_exa query="library API code example" numResults=5
```

### Use cases

| Scenario | Parameters |
|-----|-----|
| Web search | `web_search_exa(query: "...", numResults: 5)` |
| Technical / code material | `web_search_exa(query: "framework name API example", numResults: 5)` |

> Exa MCP's `get_code_context_exa` is deprecated and not registered by default. Use
> `web_search_exa` for code questions too; when you need precise search of repository contents,
> use the GitHub search in `dev.md` instead.

### Characteristics

- Strong on English-language content and technical documentation
- Can locate official docs and code examples via search queries
- High result quality

## Comparison with other search tools

| Tool | Source | Best for |
|-----|------|---------|
| Exa | agent-reach | English / technical / code search |
| Zhipu Search | my-mcp-tools | Chinese-language search |
| GitHub search | agent-reach (dev.md) | Repository / code search |
