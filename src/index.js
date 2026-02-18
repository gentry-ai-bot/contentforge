#!/usr/bin/env node
/**
 * ContentForge MCP Server
 * 
 * A content pipeline MCP server that helps AI agents create publish-ready articles.
 * 
 * Tools:
 *   - generate_article: Generate a full article from a topic + site context
 *   - source_images: Find relevant stock images for an article
 *   - enrich_links: Add affiliate links to product mentions
 *   - publish_article: Publish to a CMS endpoint
 *   - list_sites: List available sites and their categories
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'contentforge', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

// ---- Config from env ----
const CMS_API_URL = process.env.CONTENTFORGE_CMS_URL || 'https://cms-api-production-ad22.up.railway.app';
const CMS_API_KEY = process.env.CONTENTFORGE_CMS_KEY || '';
const PEXELS_API_KEY = process.env.CONTENTFORGE_PEXELS_KEY || '';
const AMAZON_TAG = process.env.CONTENTFORGE_AMAZON_TAG || 'pickwise05-20';

// ---- Helpers ----

async function cmsRequest(path, options = {}) {
  const res = await fetch(`${CMS_API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CMS_API_KEY,
      ...options.headers,
    },
  });
  return res.json();
}

async function searchPexels(query, count = 3) {
  if (!PEXELS_API_KEY) return { error: 'No Pexels API key configured' };
  const res = await fetch(
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${count}&orientation=landscape`,
    { headers: { Authorization: PEXELS_API_KEY } }
  );
  const data = await res.json();
  return (data.photos || []).map(p => ({
    id: p.id,
    url: p.src.large2x || p.src.large,
    alt: p.alt || query,
    photographer: p.photographer,
    pexelsUrl: p.url,
  }));
}

function generateSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function generateMetaDescription(title, content) {
  // Take first ~155 chars of content, cleaned
  const clean = content.replace(/[#*_\[\]()]/g, '').replace(/\n+/g, ' ').trim();
  return clean.slice(0, 155).replace(/\s+\S*$/, '') + '...';
}

function generateSchemaMarkup(article) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: article.title,
    description: article.meta_description,
    image: article.featured_image,
    author: { '@type': 'Person', name: article.author },
    datePublished: new Date().toISOString(),
    publisher: {
      '@type': 'Organization',
      name: article.site_name || 'ContentForge',
    },
  };
}

function enrichAffiliateLinks(content, tag) {
  // Find Amazon URLs without tags and add the affiliate tag
  return content.replace(
    /https:\/\/(?:www\.)?amazon\.com\/dp\/([A-Z0-9]{10})(?!\?tag=)/g,
    `https://www.amazon.com/dp/$1?tag=${tag}`
  );
}

// ---- Tool Definitions ----

const TOOLS = [
  {
    name: 'list_sites',
    description: 'List all available sites and their categories from the CMS',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'source_images',
    description: 'Search for stock images on Pexels. Returns URLs, alt text, and photographer credit.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query for images' },
        count: { type: 'number', description: 'Number of images (1-10, default 3)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'enrich_links',
    description: 'Scan article content for Amazon product URLs and add affiliate tags. Also identifies product mentions that could have affiliate links.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Article content (markdown)' },
        tag: { type: 'string', description: 'Amazon Associates tag (default: pickwise05-20)' },
      },
      required: ['content'],
    },
  },
  {
    name: 'seo_metadata',
    description: 'Generate SEO metadata for an article: slug, meta description, schema.org markup, and suggested internal links.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Article title' },
        content: { type: 'string', description: 'Article content (markdown)' },
        site: { type: 'string', description: 'Site slug to find related articles for internal linking' },
        author: { type: 'string', description: 'Author name' },
        featured_image: { type: 'string', description: 'Featured image URL' },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'publish_article',
    description: 'Publish an article to the CMS. Handles slug generation, metadata, and category assignment.',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'Site slug (e.g. "recipe", "outdoor")' },
        title: { type: 'string', description: 'Article title' },
        content: { type: 'string', description: 'Full article content (markdown)' },
        category: { type: 'string', description: 'Category name' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for the article',
        },
        meta_description: { type: 'string', description: 'SEO meta description (auto-generated if omitted)' },
        featured_image: { type: 'string', description: 'Featured image URL' },
        author: { type: 'string', description: 'Author name' },
        status: {
          type: 'string',
          enum: ['draft', 'published'],
          description: 'Publication status (default: published)',
        },
      },
      required: ['site', 'title', 'content'],
    },
  },
  {
    name: 'get_existing_articles',
    description: 'Get existing articles for a site to avoid duplicates and find internal linking opportunities.',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'Site slug' },
        limit: { type: 'number', description: 'Max articles to return (default 50)' },
      },
      required: ['site'],
    },
  },
];

// ---- Tool Handlers ----

async function handleTool(name, args) {
  switch (name) {
    case 'list_sites': {
      const sites = await cmsRequest('/api/sites');
      const result = [];
      for (const site of sites) {
        const cats = await cmsRequest(`/api/categories?site=${site.slug}`);
        result.push({
          id: site.id,
          name: site.name,
          slug: site.slug,
          domain: site.domain,
          categories: cats.map(c => ({ id: c.id, name: c.name, slug: c.slug })),
        });
      }
      return result;
    }

    case 'source_images': {
      return searchPexels(args.query, args.count || 3);
    }

    case 'enrich_links': {
      const enriched = enrichAffiliateLinks(args.content, args.tag || AMAZON_TAG);
      const changed = enriched !== args.content;
      return { content: enriched, linksEnriched: changed };
    }

    case 'seo_metadata': {
      const slug = generateSlug(args.title);
      const meta = args.meta_description || generateMetaDescription(args.title, args.content);
      const schema = generateSchemaMarkup({
        title: args.title,
        meta_description: meta,
        featured_image: args.featured_image || '',
        author: args.author || 'Editorial Team',
        site_name: args.site || 'ContentForge',
      });

      // Find related articles for internal linking
      let relatedArticles = [];
      if (args.site) {
        try {
          const articles = await cmsRequest(`/api/articles?site=${args.site}&status=published&limit=20`);
          if (Array.isArray(articles)) {
            relatedArticles = articles
              .filter(a => a.slug !== slug)
              .slice(0, 5)
              .map(a => ({ title: a.title, slug: a.slug }));
          }
        } catch (e) { /* ignore */ }
      }

      return { slug, meta_description: meta, schema_markup: schema, suggested_internal_links: relatedArticles };
    }

    case 'publish_article': {
      const slug = generateSlug(args.title);
      const meta = args.meta_description || generateMetaDescription(args.title, args.content);
      const content = enrichAffiliateLinks(args.content, AMAZON_TAG);

      // Get site ID
      const sites = await cmsRequest('/api/sites');
      const site = sites.find(s => s.slug === args.site);
      if (!site) return { error: `Site "${args.site}" not found` };

      // Find or create category
      let categoryId = null;
      if (args.category) {
        const cats = await cmsRequest(`/api/categories?site=${args.site}`);
        const cat = cats.find(c => c.name.toLowerCase() === args.category.toLowerCase());
        if (cat) {
          categoryId = cat.id;
        } else {
          const newCat = await cmsRequest('/api/categories', {
            method: 'POST',
            body: JSON.stringify({
              site_id: site.id,
              name: args.category,
              slug: generateSlug(args.category),
            }),
          });
          categoryId = newCat.id;
        }
      }

      const article = await cmsRequest('/api/articles', {
        method: 'POST',
        body: JSON.stringify({
          site_id: site.id,
          title: args.title,
          slug,
          content,
          category_id: categoryId,
          tags: args.tags || [],
          meta_description: meta,
          featured_image: args.featured_image || '',
          author: args.author || 'Editorial Team',
          status: args.status || 'published',
        }),
      });

      return { success: true, article };
    }

    case 'get_existing_articles': {
      const articles = await cmsRequest(
        `/api/articles?site=${args.site}&limit=${args.limit || 50}`
      );
      if (!Array.isArray(articles)) return { error: 'Failed to fetch articles', raw: articles };
      return articles.map(a => ({
        id: a.id,
        title: a.title,
        slug: a.slug,
        category: a.category_name,
        status: a.status,
        created: a.created_at,
      }));
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ---- MCP Setup ----

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await handleTool(name, args || {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// ---- Start ----

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('ContentForge MCP server running on stdio');
}

main().catch(console.error);
