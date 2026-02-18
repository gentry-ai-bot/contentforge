# @gentry-ai-bot/contentforge

**Content pipeline MCP server** — from topic research to published article in one workflow.

ContentForge is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that provides AI agents and LLM clients with tools for the full content creation pipeline: topic research → image sourcing → SEO metadata → affiliate link enrichment → CMS publishing.

## Available Tools

| Tool | Description |
|------|-------------|
| `list_sites` | List all available sites and their categories from the CMS |
| `source_images` | Search for stock images on Pexels (URLs, alt text, photographer credit) |
| `seo_metadata` | Generate SEO metadata: slug, meta description, schema.org markup, internal link suggestions |
| `enrich_links` | Scan article content for Amazon product URLs and add affiliate tags |
| `publish_article` | Publish a complete article to the CMS (with auto-categorization and tag support) |
| `get_existing_articles` | Retrieve existing articles from a site (for internal linking and dedup) |

## Quick Start

### Option 1: Stdio Mode (local, via npx)

```bash
npx @gentry-ai-bot/contentforge --stdio
```

### Option 2: Hosted Mode (SSE, remote)

Connect to the hosted instance:

- **SSE endpoint:** `https://bubbly-optimism-production.up.railway.app/sse`
- **Messages endpoint:** `https://bubbly-optimism-production.up.railway.app/messages`
- **Health check:** `https://bubbly-optimism-production.up.railway.app/health`

Requires an API key via the `x-api-key` header.

## MCP Client Configuration

### Claude Desktop

Add to your `claude_desktop_config.json`:

**Stdio mode (local):**
```json
{
  "mcpServers": {
    "contentforge": {
      "command": "npx",
      "args": ["@gentry-ai-bot/contentforge", "--stdio"],
      "env": {
        "CONTENTFORGE_CMS_URL": "https://your-cms-api.example.com",
        "CONTENTFORGE_CMS_KEY": "your-cms-api-key",
        "CONTENTFORGE_PEXELS_KEY": "your-pexels-api-key",
        "CONTENTFORGE_AMAZON_TAG": "your-affiliate-tag"
      }
    }
  }
}
```

**Hosted mode (SSE):**
```json
{
  "mcpServers": {
    "contentforge": {
      "url": "https://bubbly-optimism-production.up.railway.app/sse",
      "headers": {
        "x-api-key": "your-api-key"
      }
    }
  }
}
```

### Other MCP Clients

Any MCP-compatible client can connect via:
- **Stdio:** Run `npx @gentry-ai-bot/contentforge --stdio` as a subprocess
- **SSE:** Connect to the `/sse` endpoint with an `x-api-key` header

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CONTENTFORGE_CMS_URL` | Yes (stdio) | CMS API base URL |
| `CONTENTFORGE_CMS_KEY` | Yes (stdio) | CMS API key |
| `CONTENTFORGE_PEXELS_KEY` | Yes | Pexels API key for image sourcing |
| `CONTENTFORGE_AMAZON_TAG` | No | Amazon affiliate tag (default: `pickwise05-20`) |
| `CONTENTFORGE_API_KEY` | No | API key for hosted mode authentication |
| `PORT` | No | HTTP server port (default: `3000`) |

## Authentication

- **Stdio mode:** No auth needed — runs locally as a subprocess
- **Hosted mode:** Pass your API key via the `x-api-key` HTTP header on both `/sse` and `/messages` endpoints
- Rate limited to 100 requests/hour per API key

## How It Works

1. **Research** — Use `list_sites` and `get_existing_articles` to understand what content exists
2. **Source Images** — Use `source_images` to find relevant stock photography from Pexels
3. **Optimize** — Use `seo_metadata` to generate slugs, meta descriptions, and schema.org markup
4. **Monetize** — Use `enrich_links` to automatically add affiliate tags to product links
5. **Publish** — Use `publish_article` to push the finished article to your CMS

## License

MIT
