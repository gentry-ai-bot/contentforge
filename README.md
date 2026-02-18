# ContentForge

A content pipeline MCP server that turns topics into publish-ready articles.

## What it does

ContentForge gives AI agents a complete content publishing toolkit:

- **`list_sites`** — Browse available sites and categories from your CMS
- **`get_existing_articles`** — Check what's already published (avoid duplicates, find linking opportunities)
- **`source_images`** — Search Pexels for stock photos with proper attribution
- **`seo_metadata`** — Generate slugs, meta descriptions, schema.org markup, and internal link suggestions
- **`enrich_links`** — Auto-tag Amazon affiliate links in your content
- **`publish_article`** — Push directly to your CMS with category assignment and tag management

## Quick Start

```bash
npm install
```

### As an MCP server (stdio)

```json
{
  "mcpServers": {
    "contentforge": {
      "command": "node",
      "args": ["/path/to/contentforge/src/index.js"],
      "env": {
        "CONTENTFORGE_CMS_URL": "https://your-cms-api.example.com",
        "CONTENTFORGE_CMS_KEY": "your-api-key",
        "CONTENTFORGE_PEXELS_KEY": "your-pexels-key",
        "CONTENTFORGE_AMAZON_TAG": "your-tag-20"
      }
    }
  }
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CONTENTFORGE_CMS_URL` | Yes | Your CMS API endpoint |
| `CONTENTFORGE_CMS_KEY` | Yes | API key for CMS authentication |
| `CONTENTFORGE_PEXELS_KEY` | No | Pexels API key for image sourcing |
| `CONTENTFORGE_AMAZON_TAG` | No | Amazon Associates tag (default: pickwise05-20) |

## Typical Agent Workflow

1. `list_sites` → pick a site
2. `get_existing_articles` → see what's published, avoid duplicates
3. Agent writes article content (using its own LLM)
4. `source_images` → find a hero image
5. `seo_metadata` → generate slug, meta, schema markup
6. `enrich_links` → add affiliate tags
7. `publish_article` → push to CMS

## License

MIT
