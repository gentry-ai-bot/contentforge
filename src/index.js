#!/usr/bin/env node
/**
 * ContentForge MCP Server
 * 
 * Supports both stdio (--stdio flag) and HTTP/SSE transport.
 * HTTP mode includes API key auth, rate limiting, and usage tracking.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';

// ---- Config from env ----
const CMS_API_URL = process.env.CONTENTFORGE_CMS_URL || 'https://cms-api-production-ad22.up.railway.app';
const CMS_API_KEY = process.env.CONTENTFORGE_CMS_KEY || '';
const PEXELS_API_KEY = process.env.CONTENTFORGE_PEXELS_KEY || '';
const AMAZON_TAG = process.env.CONTENTFORGE_AMAZON_TAG || 'pickwise05-20';
const API_KEY = process.env.CONTENTFORGE_API_KEY || '';
const PORT = parseInt(process.env.PORT || '3000', 10);

// ---- Rate Limiting (in-memory) ----
const rateLimits = new Map(); // key -> { count, resetAt }
const RATE_LIMIT = 100;
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function checkRateLimit(apiKey) {
  const now = Date.now();
  let entry = rateLimits.get(apiKey);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateLimits.set(apiKey, entry);
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

// ---- Usage Tracking ----
function logUsage(toolName, apiKey) {
  console.log(JSON.stringify({
    type: 'tool_call',
    tool: toolName,
    apiKey: apiKey ? apiKey.slice(0, 8) + '...' : 'stdio',
    timestamp: new Date().toISOString(),
  }));
}

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
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function generateMetaDescription(title, content) {
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
    publisher: { '@type': 'Organization', name: article.site_name || 'ContentForge' },
  };
}

function enrichAffiliateLinks(content, tag) {
  return content.replace(
    /https:\/\/(?:www\.)?amazon\.com\/dp\/([A-Z0-9]{10})(?!\?tag=)/g,
    `https://www.amazon.com/dp/$1?tag=${tag}`
  );
}

// ---- Content Brief Generation ----

async function generateContentBrief(site, count = 5) {
  // Get existing articles to avoid duplicates
  const articles = await cmsRequest(`/api/articles?site=${site}&status=published&limit=200`);
  const existingTitles = Array.isArray(articles) ? articles.map(a => a.title.toLowerCase()) : [];
  const existingSlugs = Array.isArray(articles) ? articles.map(a => a.slug) : [];
  const cats = await cmsRequest(`/api/categories?site=${site}`);
  
  // Analyze content distribution across categories
  const catCounts = {};
  if (Array.isArray(articles)) {
    articles.forEach(a => {
      const cat = a.category_name || 'uncategorized';
      catCounts[cat] = (catCounts[cat] || 0) + 1;
    });
  }
  
  return {
    site,
    total_articles: Array.isArray(articles) ? articles.length : 0,
    categories: Array.isArray(cats) ? cats.map(c => ({ name: c.name, slug: c.slug, article_count: catCounts[c.name] || 0 })) : [],
    existing_titles: existingTitles.slice(0, 50),
    content_distribution: catCounts,
    suggestion: `Site has ${Array.isArray(articles) ? articles.length : 0} articles. Least-covered categories should be prioritized. Generate ${count} new article ideas that don't overlap with existing content.`,
  };
}

async function getPortfolioStats() {
  const sites = await cmsRequest('/api/sites');
  const stats = [];
  for (const site of (Array.isArray(sites) ? sites : [])) {
    const articles = await cmsRequest(`/api/articles?site=${site.slug}&limit=1000`);
    const published = Array.isArray(articles) ? articles.filter(a => a.status === 'published').length : 0;
    const draft = Array.isArray(articles) ? articles.filter(a => a.status === 'draft').length : 0;
    const cats = await cmsRequest(`/api/categories?site=${site.slug}`);
    stats.push({
      site: site.name, slug: site.slug, domain: site.domain,
      published, draft, total: published + draft,
      categories: Array.isArray(cats) ? cats.length : 0,
    });
  }
  return {
    total_sites: stats.length,
    total_articles: stats.reduce((s, x) => s + x.total, 0),
    total_published: stats.reduce((s, x) => s + x.published, 0),
    sites: stats,
  };
}

// ---- Tool Definitions ----

const TOOLS = [
  {
    name: 'list_sites',
    description: 'List all available sites and their categories from the CMS',
    inputSchema: { type: 'object', properties: {} },
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
    description: 'Scan article content for Amazon product URLs and add affiliate tags.',
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
        site: { type: 'string', description: 'Site slug for internal linking' },
        author: { type: 'string', description: 'Author name' },
        featured_image: { type: 'string', description: 'Featured image URL' },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'publish_article',
    description: 'Publish an article to the CMS.',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'Site slug' },
        title: { type: 'string', description: 'Article title' },
        content: { type: 'string', description: 'Full article content (markdown)' },
        category: { type: 'string', description: 'Category name' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags' },
        meta_description: { type: 'string', description: 'SEO meta description' },
        featured_image: { type: 'string', description: 'Featured image URL' },
        author: { type: 'string', description: 'Author name' },
        status: { type: 'string', enum: ['draft', 'published'], description: 'Status (default: published)' },
      },
      required: ['site', 'title', 'content'],
    },
  },
  {
    name: 'content_brief',
    description: 'Generate a content brief for a site: analyzes existing content, identifies gaps, and provides data for planning new articles. Use this before writing to avoid duplicate topics.',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'Site slug' },
        count: { type: 'number', description: 'Number of article ideas to plan for (default 5)' },
      },
      required: ['site'],
    },
  },
  {
    name: 'portfolio_stats',
    description: 'Get aggregate statistics across all sites in the CMS: article counts, category distribution, published vs draft.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'batch_publish',
    description: 'Publish multiple articles to a site in one call. Each article needs title, content, and optionally category, tags, meta_description, featured_image.',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'Site slug' },
        articles: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              content: { type: 'string' },
              category: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              meta_description: { type: 'string' },
              featured_image: { type: 'string' },
              author: { type: 'string' },
            },
            required: ['title', 'content'],
          },
          description: 'Array of articles to publish',
        },
      },
      required: ['site', 'articles'],
    },
  },
  {
    name: 'get_existing_articles',
    description: 'Get existing articles for a site.',
    inputSchema: {
      type: 'object',
      properties: {
        site: { type: 'string', description: 'Site slug' },
        limit: { type: 'number', description: 'Max articles (default 50)' },
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
          id: site.id, name: site.name, slug: site.slug, domain: site.domain,
          categories: cats.map(c => ({ id: c.id, name: c.name, slug: c.slug })),
        });
      }
      return result;
    }
    case 'source_images':
      return searchPexels(args.query, args.count || 3);
    case 'enrich_links': {
      const enriched = enrichAffiliateLinks(args.content, args.tag || AMAZON_TAG);
      return { content: enriched, linksEnriched: enriched !== args.content };
    }
    case 'seo_metadata': {
      const slug = generateSlug(args.title);
      const meta = args.meta_description || generateMetaDescription(args.title, args.content);
      const schema = generateSchemaMarkup({
        title: args.title, meta_description: meta,
        featured_image: args.featured_image || '', author: args.author || 'Editorial Team',
        site_name: args.site || 'ContentForge',
      });
      let relatedArticles = [];
      if (args.site) {
        try {
          const articles = await cmsRequest(`/api/articles?site=${args.site}&status=published&limit=20`);
          if (Array.isArray(articles)) {
            relatedArticles = articles.filter(a => a.slug !== slug).slice(0, 5).map(a => ({ title: a.title, slug: a.slug }));
          }
        } catch (e) { /* ignore */ }
      }
      return { slug, meta_description: meta, schema_markup: schema, suggested_internal_links: relatedArticles };
    }
    case 'publish_article': {
      const slug = generateSlug(args.title);
      const meta = args.meta_description || generateMetaDescription(args.title, args.content);
      const content = enrichAffiliateLinks(args.content, AMAZON_TAG);
      const sites = await cmsRequest('/api/sites');
      const site = sites.find(s => s.slug === args.site);
      if (!site) return { error: `Site "${args.site}" not found` };
      let categoryId = null;
      if (args.category) {
        const cats = await cmsRequest(`/api/categories?site=${args.site}`);
        const cat = cats.find(c => c.name.toLowerCase() === args.category.toLowerCase());
        if (cat) { categoryId = cat.id; }
        else {
          const newCat = await cmsRequest('/api/categories', {
            method: 'POST', body: JSON.stringify({ site_id: site.id, name: args.category, slug: generateSlug(args.category) }),
          });
          categoryId = newCat.id;
        }
      }
      const article = await cmsRequest('/api/articles', {
        method: 'POST', body: JSON.stringify({
          site_id: site.id, title: args.title, slug, content, category_id: categoryId,
          tags: args.tags || [], meta_description: meta, featured_image: args.featured_image || '',
          author: args.author || 'Editorial Team', status: args.status || 'published',
        }),
      });
      return { success: true, article };
    }
    case 'content_brief':
      return generateContentBrief(args.site, args.count || 5);
    case 'portfolio_stats':
      return getPortfolioStats();
    case 'batch_publish': {
      const sites = await cmsRequest('/api/sites');
      const site = sites.find(s => s.slug === args.site);
      if (!site) return { error: `Site "${args.site}" not found` };
      const results = [];
      for (const art of args.articles) {
        try {
          const slug = generateSlug(art.title);
          const meta = art.meta_description || generateMetaDescription(art.title, art.content);
          const content = enrichAffiliateLinks(art.content, AMAZON_TAG);
          let categoryId = null;
          if (art.category) {
            const cats = await cmsRequest(`/api/categories?site=${args.site}`);
            const cat = cats.find(c => c.name.toLowerCase() === art.category.toLowerCase());
            if (cat) categoryId = cat.id;
            else {
              const newCat = await cmsRequest('/api/categories', {
                method: 'POST', body: JSON.stringify({ site_id: site.id, name: art.category, slug: generateSlug(art.category) }),
              });
              categoryId = newCat.id;
            }
          }
          const article = await cmsRequest('/api/articles', {
            method: 'POST', body: JSON.stringify({
              site_id: site.id, title: art.title, slug, content, category_id: categoryId,
              tags: art.tags || [], meta_description: meta, featured_image: art.featured_image || '',
              author: art.author || 'Editorial Team', status: 'published',
            }),
          });
          results.push({ title: art.title, slug, success: true, id: article.id });
        } catch (e) {
          results.push({ title: art.title, success: false, error: e.message });
        }
      }
      return { published: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length, results };
    }
    case 'get_existing_articles': {
      const articles = await cmsRequest(`/api/articles?site=${args.site}&limit=${args.limit || 50}`);
      if (!Array.isArray(articles)) return { error: 'Failed to fetch articles', raw: articles };
      return articles.map(a => ({ id: a.id, title: a.title, slug: a.slug, category: a.category_name, status: a.status, created: a.created_at }));
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ---- MCP Server Factory ----

function createServer() {
  const srv = new Server(
    { name: 'contentforge', version: '0.2.0' },
    { capabilities: { tools: {} } }
  );

  srv.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  srv.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    logUsage(name, srv._currentApiKey || null);
    try {
      const result = await handleTool(name, args || {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
    }
  });

  return srv;
}

// ---- HTTP/SSE Mode ----

function startHttpServer() {
  const app = express();
  app.use(express.json());

  // Health check (no auth)
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', server: 'contentforge', version: '0.2.0' });
  });

  // Auth middleware for MCP endpoints
  function authMiddleware(req, res, next) {
    const key = req.headers['x-api-key'];
    if (!API_KEY) { next(); return; } // no key configured = open
    if (key !== API_KEY) {
      res.status(401).json({ error: 'Invalid or missing API key' });
      return;
    }
    if (!checkRateLimit(key)) {
      res.status(429).json({ error: 'Rate limit exceeded (100 req/hr)' });
      return;
    }
    req.apiKey = key;
    next();
  }

  const transports = {};

  // SSE endpoint
  app.get('/sse', authMiddleware, async (req, res) => {
    console.log('SSE connection requested');
    try {
      const transport = new SSEServerTransport('/messages', res);
      const sessionId = transport.sessionId;
      transports[sessionId] = transport;
      transport.onclose = () => {
        console.log(`SSE closed: ${sessionId}`);
        delete transports[sessionId];
      };
      const server = createServer();
      server._currentApiKey = req.apiKey || null;
      await server.connect(transport);
      console.log(`SSE established: ${sessionId}`);
    } catch (error) {
      console.error('SSE error:', error);
      if (!res.headersSent) res.status(500).send('Error establishing SSE stream');
    }
  });

  // Messages endpoint
  app.post('/messages', authMiddleware, async (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) { res.status(400).json({ error: 'Missing sessionId' }); return; }
    const transport = transports[sessionId];
    if (!transport) { res.status(404).json({ error: 'Session not found' }); return; }
    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      console.error('Message error:', error);
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    }
  });

  app.listen(PORT, () => {
    console.log(`ContentForge HTTP/SSE server listening on port ${PORT}`);
  });
}

// ---- Stdio Mode ----

async function startStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('ContentForge MCP server running on stdio');
}

// ---- Main ----

if (process.argv.includes('--stdio')) {
  startStdio().catch(console.error);
} else {
  startHttpServer();
}
