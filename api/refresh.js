import { list, put } from "@vercel/blob";
import Anthropic from "@anthropic-ai/sdk";
import * as cheerio from "cheerio";
import { readFileSync } from "fs";
import { join } from "path";

const VALID_DATASETS = { moontower: "moontower_enriched", substack: "substack_enriched", blog: "blog_enriched" };
const MODEL_NAME = "claude-haiku-4-5-20251001";
const BATCH_LIMIT = 10; // max posts to scrape+enrich per refresh (to stay within 60s timeout)
const ENRICHMENT_CONCURRENCY = 5; // parallel Claude calls for enrichment
const TIME_BUDGET_MS = 55000; // reserve 5s before Vercel's 60s hard limit for saving

export const maxDuration = 60;

// ============================================================
// Helpers
// ============================================================
function stripFences(text) {
  text = text.trim();
  if (text.startsWith("```")) {
    const newlineIdx = text.indexOf("\n");
    if (newlineIdx !== -1) {
      text = text.slice(newlineIdx + 1);
    } else {
      text = text.slice(3);
    }
  }
  if (text.endsWith("```")) text = text.slice(0, -3);
  return text.trim();
}

async function fetchPage(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; MindMapBot/1.0)" },
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return await resp.text();
}

// ============================================================
// Load existing data (from Vercel Blob or static fallback)
// ============================================================
async function loadExistingData(blobKey) {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      const { blobs } = await list({ prefix: `mindmap-data/${blobKey}` });
      if (blobs.length > 0) {
        const resp = await fetch(blobs[0].downloadUrl);
        return await resp.json();
      }
    } catch (e) {
      console.log("Blob read failed:", e.message);
    }
  }
  const filePath = join(process.cwd(), "data", `${blobKey}.json`);
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

// ============================================================
// Moontower scraping
// ============================================================
async function scrapeMoontowerNew(existingUrls) {
  const indexHtml = await fetchPage("https://moontowerquant.com/moontower-content-by-kris-abdelmessih");
  const $ = cheerio.load(indexHtml);

  const categoryUrls = [];
  const skipPaths = ["/moontower-content-by-kris-abdelmessih", "/about", "/contact", "/subscribe", "/newsletter"];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().trim();
    if (!text || href.startsWith("#") || href.startsWith("mailto:")) return;

    let fullUrl;
    if (href.startsWith("/")) fullUrl = `https://moontowerquant.com${href}`;
    else if (href.startsWith("https://moontowerquant.com/")) fullUrl = href;
    else return;

    const path = fullUrl.replace("https://moontowerquant.com", "");
    if (skipPaths.includes(path) || !path || path === "/") return;
    if (!categoryUrls.find((c) => c.url === fullUrl)) {
      categoryUrls.push({ url: fullUrl, name: text });
    }
  });

  const allArticles = [];
  const seenUrls = new Set();

  for (const cat of categoryUrls) {
    try {
      const catHtml = await fetchPage(cat.url);
      const $cat = cheerio.load(catHtml);

      $cat('a[href*="moontowermeta.com"]').each((_, el) => {
        const href = $cat(el).attr("href");
        const title = $cat(el).text().trim();
        if (title && !seenUrls.has(href)) {
          seenUrls.add(href);
          allArticles.push({ url: href, title, category: cat.name });
        }
      });
    } catch (e) {
      console.log(`Error fetching category ${cat.name}: ${e.message}`);
    }
  }

  const newArticles = allArticles.filter((a) => !existingUrls.has(a.url));
  console.log(`Moontower: ${allArticles.length} total, ${newArticles.length} new`);

  const results = [];

  for (const article of newArticles) {
    try {
      const pageHtml = await fetchPage(article.url);
      const $page = cheerio.load(pageHtml);

      let title = $page("h1").first().text().trim();
      if (!title) title = $page("title").text().trim();
      if (!title) title = article.title;

      let text = "";
      for (const selector of ["article", ".post-content", ".entry-content", ".content", "main"]) {
        const el = $page(selector).first();
        if (el.length) {
          el.find("script, style, nav, footer, header").remove();
          text = el.text().trim();
          break;
        }
      }
      if (!text) {
        const body = $page("body");
        body.find("script, style, nav, footer, header").remove();
        text = body.text().trim();
      }

      results.push({
        id: null,
        title: title || article.title,
        url: article.url,
        category: article.category,
        text: text || "",
      });
    } catch (e) {
      console.log(`Error fetching article ${article.url}: ${e.message}`);
    }
  }
  return results;
}

// ============================================================
// Substack scraping
// ============================================================
async function scrapeSubstackNew(existingIds) {
  const SUBSTACK_DOMAIN = "moontower.substack.com";
  const ARCHIVE_API = `https://${SUBSTACK_DOMAIN}/api/v1/archive`;
  const PAGE_SIZE = 50; // larger page = fewer round-trips

  // Paginate newest-first. Stop early once we hit already-seen posts
  // or have collected enough new candidates.
  const newPosts = [];
  let offset = 0;
  let totalFetched = 0;

  while (true) {
    const url = `${ARCHIVE_API}?sort=new&limit=${PAGE_SIZE}&offset=${offset}`;
    let resp;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        resp = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; MindMapBot/1.0)" },
          signal: AbortSignal.timeout(20000),
        });
        if (resp.ok) break;
        console.error(`Substack archive API returned HTTP ${resp.status} at offset ${offset} (attempt ${attempt + 1})`);
        resp = null;
      } catch (e) {
        console.error(`Substack fetch error at offset ${offset} (attempt ${attempt + 1}): ${e.message}`);
        resp = null;
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
    if (!resp || !resp.ok) break;

    let posts;
    try {
      posts = await resp.json();
      if (!posts || posts.length === 0) break;
    } catch (e) {
      console.error(`Substack JSON parse error at offset ${offset}: ${e.message}`);
      break;
    }

    totalFetched += posts.length;
    let hitExisting = false;
    for (const p of posts) {
      if (existingIds.has(`ss_${p.id}`)) {
        hitExisting = true;
      } else {
        newPosts.push(p);
      }
    }

    offset += PAGE_SIZE;

    // Stop paginating once we hit already-seen posts or have enough candidates
    if (hitExisting || newPosts.length >= BATCH_LIMIT) break;
  }

  console.log(`Substack: ${totalFetched} total fetched, ${newPosts.length} new (processing up to ${BATCH_LIMIT})`);
  if (totalFetched === 0) {
    throw new Error("Substack archive API returned no posts — the API may be blocked or down. Check Vercel function logs for details.");
  }

  const results = [];
  for (const post of newPosts.slice(0, BATCH_LIMIT)) {
    try {
      const postUrl = post.canonical_url || `https://${SUBSTACK_DOMAIN}/p/${post.slug}`;
      let text = "";

      if (post.body_html) {
        const $ = cheerio.load(post.body_html);
        $("script, style, nav, footer, header").remove();
        text = $.root().text().trim();
      } else {
        const pageHtml = await fetchPage(postUrl);
        const $ = cheerio.load(pageHtml);
        for (const selector of [".body", ".post-content", ".available-content", "article", "main"]) {
          const el = $(selector).first();
          if (el.length) {
            el.find("script, style, nav, footer, header").remove();
            text = el.text().trim();
            break;
          }
        }
        if (!text) {
          const body = $("body");
          body.find("script, style, nav, footer, header").remove();
          text = body.text().trim();
        }
      }

      results.push({
        id: `ss_${post.id}`,
        title: post.title || "Untitled",
        subtitle: post.subtitle || "",
        url: postUrl,
        date: post.post_date || null,
        category: post.type || "newsletter",
        text: text || "",
      });
    } catch (e) {
      console.log(`Error fetching Substack post ${post.id}: ${e.message}`);
    }
  }
  return { items: results, totalNew: newPosts.length };
}

// ============================================================
// blog.moontower.ai scraping (Ghost blog)
// ============================================================
async function scrapeBlogNew(existingIds) {
  const BLOG_URL = "https://blog.moontower.ai";
  const allPostUrls = [];

  try {
    const sitemapHtml = await fetchPage(`${BLOG_URL}/sitemap-posts.xml`);
    const $ = cheerio.load(sitemapHtml, { xmlMode: true });
    $("url loc").each((_, el) => {
      const loc = $(el).text().trim();
      if (loc && loc !== BLOG_URL + "/") allPostUrls.push(loc);
    });
  } catch (e) {
    console.log(`Blog sitemap error: ${e.message}`);
  }

  if (!allPostUrls.length) {
    try {
      const sitemapHtml = await fetchPage(`${BLOG_URL}/sitemap.xml`);
      const $ = cheerio.load(sitemapHtml, { xmlMode: true });
      const postsSitemapUrl = [];
      $("sitemap loc").each((_, el) => {
        const loc = $(el).text().trim();
        if (loc.includes("posts")) postsSitemapUrl.push(loc);
      });
      for (const url of postsSitemapUrl) {
        const subHtml = await fetchPage(url);
        const $sub = cheerio.load(subHtml, { xmlMode: true });
        $sub("url loc").each((_, el) => {
          const loc = $sub(el).text().trim();
          if (loc && loc !== BLOG_URL + "/") allPostUrls.push(loc);
        });
      }
      if (!allPostUrls.length) {
        $("url loc").each((_, el) => {
          const loc = $(el).text().trim();
          if (loc && loc !== BLOG_URL + "/") allPostUrls.push(loc);
        });
      }
    } catch (e) {
      console.log(`Blog sitemap index error: ${e.message}`);
    }
  }

  const skipPrefixes = ["/tag/", "/author/", "/page/", "/ghost/"];
  const postUrls = allPostUrls.filter((url) => {
    const path = url.replace(BLOG_URL, "");
    return !skipPrefixes.some((p) => path.startsWith(p)) && path !== "" && path !== "/";
  });

  const newPostUrls = postUrls.filter((url) => {
    const slug = url.replace(BLOG_URL, "").replace(/^\/|\/$/g, "");
    return !existingIds.has(`blog_${slug}`);
  });

  console.log(`Blog: ${postUrls.length} total, ${newPostUrls.length} new (processing up to ${BATCH_LIMIT})`);
  if (postUrls.length === 0) {
    throw new Error("blog.moontower.ai sitemap returned no posts — the site may be down or the sitemap structure changed.");
  }

  const results = [];
  for (const postUrl of newPostUrls.slice(0, BATCH_LIMIT)) {
    try {
      const pageHtml = await fetchPage(postUrl);
      const $ = cheerio.load(pageHtml);

      let title = $("h1").first().text().trim();
      if (!title) title = $('meta[property="og:title"]').attr("content") || "";
      if (!title) title = $("title").text().trim();

      let text = "";
      for (const selector of [".gh-content", ".post-content", ".post-full-content", ".article-content", "article", ".content", "main"]) {
        const el = $(selector).first();
        if (el.length) {
          el.find("script, style, nav, footer, header").remove();
          text = el.text().trim();
          break;
        }
      }
      if (!text) {
        const body = $("body");
        body.find("script, style, nav, footer, header").remove();
        text = body.text().trim();
      }

      const slug = postUrl.replace(BLOG_URL, "").replace(/^\/|\/$/g, "");
      results.push({
        id: `blog_${slug}`,
        title: title || slug,
        url: postUrl,
        category: "blog",
        text: text || "",
      });
    } catch (e) {
      console.log(`Error fetching blog post ${postUrl}: ${e.message}`);
    }
  }
  return { items: results, totalNew: newPostUrls.length };
}

// ============================================================
// Claude (Anthropic) enrichment
// ============================================================
function getClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  return new Anthropic({ apiKey: key });
}

async function askClaude(client, prompt, maxTokens = 4096) {
  const msg = await client.messages.create({
    model: MODEL_NAME,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  return stripFences(msg.content[0].text);
}

async function enrichSingleItem(client, item) {
  let content = (item.text || "").slice(0, 8000);
  if (!content.trim()) content = `(No content. Title: ${item.title})`;
  const existingCategory = item.category && item.category !== "Unknown" && item.category !== "General" ? item.category : null;
  const categoryInstruction = existingCategory
    ? `The article's known category is "${existingCategory}". Use this as the category unless it is clearly wrong.`
    : `Assign the most fitting category from this list: "Options and Volatility", "Risk and the math of returns", "Numeracy & Decision-Making", "Probability & Statistics", "Behavioral Finance & Psychology", "Portfolio Theory", "Valuation & Capital Allocation", "Compounding & Growth", "Training, Interviews, & Career", "Commentary", "Investing", "Market Microstructure". Pick the single best match.`;
  const prompt = `Analyze this article by Kris Abdelmessih (Moontower) about finance, options, volatility, or decision-making.

Title: ${item.title}
${existingCategory ? `Category: ${existingCategory}` : ""}

Article content:
${content}

${categoryInstruction}

Return JSON (no markdown fences):
{
  "summary": "2-3 sentence summary of the article's key message",
  "concepts": ["list", "of", "key", "concepts"],
  "difficulty": "beginner|intermediate|advanced",
  "category": "the topic category for this article"
}`;

  const text = await askClaude(client, prompt);
  return JSON.parse(text);
}

async function generateConnections(client, allItems) {
  const summaries = allItems
    .map(
      (t) =>
        `ID: ${t.id}\nTitle: ${t.title}\nSummary: ${t.summary || "N/A"}\nConcepts: ${(t.concepts || []).join(", ")}\nDifficulty: ${t.difficulty || "N/A"}`
    )
    .join("\n\n");

  const clusterGuidance = "options pricing, volatility surface, probability/calibration, decision-making, career/life advice, market microstructure, risk management, behavioral finance";
  const colors = "#4e79a7, #f28e2b, #e15759, #76b7b2, #59a14f, #edc948, #b07aa1, #ff9da7, #9c755f, #bab0ac";

  const prompt = `You have ${allItems.length} finance/investing items.

Here are all items:

${summaries}

Analyze relationships and return JSON (no markdown fences):
{
  "edges": [
    {"source": "id", "target": "id", "type": "builds_on|contrasts_with|applies_concept_from|prerequisite_for", "strength": 0.1-1.0, "reason": "brief explanation"}
  ],
  "clusters": [
    {"name": "Cluster Name", "color": "#hexcolor", "thread_ids": ["id1", "id2"], "description": "what this cluster covers"}
  ],
  "learning_paths": [
    {"name": "Path Name", "description": "who this path is for", "thread_ids": ["id1", "id2"]}
  ]
}

Guidelines:
- Create 6-10 topic clusters (${clusterGuidance})
- Create 3-5 learning paths
- Include 30-60 edges capturing the most meaningful connections
- Every item should belong to exactly one cluster
- Use these colors: ${colors}`;

  const text = await askClaude(client, prompt, 8192);
  return JSON.parse(text);
}

// ============================================================
// Quiz generation
// ============================================================
async function generateQuizzes(client, items, edges) {
  const quizzes = [];
  const batchSize = 10;

  const topicLabel = "articles about options, volatility, and decision-making by Kris Abdelmessih";

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const block = batch
      .map((t) => `ID: ${t.id}\nTitle: ${t.title}\nSummary: ${t.summary || "N/A"}\nConcepts: ${(t.concepts || []).join(", ")}\nDifficulty: ${t.difficulty || "intermediate"}`)
      .join("\n\n");

    const prompt = `Generate quiz questions for these ${topicLabel}.

${block}

For EACH item, generate exactly 2 questions:
1. A concept_recall question (open-ended, tests understanding of the key idea)
2. A multiple_choice question (4 choices, tests specific knowledge)

Return JSON array (no markdown fences):
[
  {"id": "q_<item_id>_0", "thread_id": "<item_id>", "type": "concept_recall", "question": "...", "answer": "...", "difficulty": "beginner|intermediate|advanced", "concepts": ["concept1"]},
  {"id": "q_mc_<item_id>_0", "thread_id": "<item_id>", "type": "multiple_choice", "question": "...", "choices": ["A) ...", "B) ...", "C) ...", "D) ..."], "correct_index": 0, "explanation": "...", "difficulty": "beginner|intermediate|advanced", "concepts": ["concept1"]}
]

Make questions test genuine understanding, not just memorization.`;

    try {
      const text = await askClaude(client, prompt);
      quizzes.push(...JSON.parse(text));
    } catch (e) {
      console.log(`Quiz batch error: ${e.message}`);
    }
  }

  const titleMap = Object.fromEntries(items.map((t) => [t.id, t.title]));
  const edgeBatchSize = 20;
  for (let i = 0; i < edges.length; i += edgeBatchSize) {
    const batch = edges.slice(i, i + edgeBatchSize);
    const edgeContext = batch.map((e) => `${titleMap[e.source] || e.source} -> ${titleMap[e.target] || e.target}: ${e.reason || "N/A"}`).join("\n");

    const prompt = `Generate 1 connection quiz question per edge. These edges connect ${topicLabel}.

Edges:
${edgeContext}

Return JSON array (no markdown fences):
[{"id": "q_edge_<source_id>_<target_id>_0", "type": "connection", "source_thread_id": "<source_id>", "target_thread_id": "<target_id>", "question": "...", "answer": "...", "difficulty": "intermediate", "concepts": ["concept1"]}]`;

    try {
      const text = await askClaude(client, prompt);
      quizzes.push(...JSON.parse(text));
    } catch (e) {
      console.log(`Edge quiz batch error: ${e.message}`);
    }
  }

  return quizzes;
}

// ============================================================
// Main handler
// ============================================================
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const dataset = req.query.dataset || "moontower";
  if (!VALID_DATASETS[dataset]) {
    return res.status(400).json({ error: "Invalid dataset" });
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({ error: "Vercel Blob not configured. Add a Blob store to enable refresh." });
  }

  const blobKey = VALID_DATASETS[dataset];

  try {
    // 1. Load existing data
    const existing = await loadExistingData(blobKey);
    const existingThreads = existing.threads || [];

    // 2. Scrape for new items (batched — returns up to BATCH_LIMIT)
    let newRawItems;
    let totalNewAvailable = 0;
    if (dataset === "substack") {
      const existingIds = new Set(existingThreads.map((t) => t.id));
      const { items, totalNew } = await scrapeSubstackNew(existingIds);
      newRawItems = items;
      totalNewAvailable = totalNew;
    } else if (dataset === "blog") {
      const existingIds = new Set(existingThreads.map((t) => t.id));
      const { items, totalNew } = await scrapeBlogNew(existingIds);
      newRawItems = items;
      totalNewAvailable = totalNew;
    } else {
      const existingUrls = new Set(existingThreads.map((t) => t.url));
      newRawItems = await scrapeMoontowerNew(existingUrls);
    }

    // Check if there are stale items that need re-enrichment (missing summary/concepts OR missing category)
    const needsCategory = (t) => !t.category || t.category === "Unknown" || t.category === "General";
    const needsCluster = (t) => !t.cluster || t.cluster === "General";
    const needsEnrichment = (t) => !t.summary || !t.concepts || t.concepts.length === 0;
    const staleCount = existingThreads.filter((t) => needsEnrichment(t) || needsCategory(t)).length;
    if (newRawItems.length === 0 && staleCount === 0) {
      return res.status(200).json({ success: true, newCount: 0, message: "No new articles found. All existing articles are enriched." });
    }

    // 3. Assign IDs to new Moontower articles
    if (dataset === "moontower") {
      const maxId = Math.max(0, ...existingThreads.map((t) => parseInt(t.id.replace("mt_", "")) || 0));
      newRawItems.forEach((item, i) => {
        item.id = `mt_${maxId + i + 1}`;
      });
    }

    // 4. Enrich new items + re-enrich existing items with missing data
    const client = getClient();
    const startTime = Date.now();
    const enrichErrors = [];

    async function enrichWithFallback(item) {
      try {
        const meta = await enrichSingleItem(client, item);
        return {
          ...item,
          summary: meta.summary || "",
          concepts: meta.concepts || [],
          difficulty: meta.difficulty || "intermediate",
          category: meta.category || item.category || "General",
        };
      } catch (e) {
        const errMsg = `${item.title}: ${e.message}`.slice(0, 120);
        console.log(`Enrichment error for ${errMsg}`);
        enrichErrors.push(errMsg);
        return { ...item, summary: "", concepts: [], difficulty: "intermediate" };
      }
    }

    // Find existing items with missing enrichment or missing category
    const staleItems = existingThreads.filter(
      (t) => needsEnrichment(t) || needsCategory(t)
    );
    // Prioritize items missing enrichment first, then items just missing category
    staleItems.sort((a, b) => {
      const aEnrich = needsEnrichment(a) ? 0 : 1;
      const bEnrich = needsEnrichment(b) ? 0 : 1;
      return aEnrich - bEnrich;
    });
    const itemsToEnrich = [...newRawItems, ...staleItems.slice(0, BATCH_LIMIT)];
    console.log(`Enriching: ${newRawItems.length} new + ${Math.min(staleItems.length, BATCH_LIMIT)} stale (of ${staleItems.length} total stale, ${staleItems.filter(needsCategory).length} need category)`);

    // Process in parallel batches of ENRICHMENT_CONCURRENCY
    const enrichedResults = [];
    for (let i = 0; i < itemsToEnrich.length; i += ENRICHMENT_CONCURRENCY) {
      const batch = itemsToEnrich.slice(i, i + ENRICHMENT_CONCURRENCY);
      const results = await Promise.all(batch.map(enrichWithFallback));
      enrichedResults.push(...results);
    }
    const enrichDone = Date.now();
    console.log(`Enrichment took ${enrichDone - startTime}ms for ${enrichedResults.length} items`);

    // Split results: new items vs re-enriched existing items
    const enrichedNew = enrichedResults.slice(0, newRawItems.length);
    const reEnriched = enrichedResults.slice(newRawItems.length);

    // Update existing threads with re-enriched data
    if (reEnriched.length > 0) {
      const reEnrichedMap = new Map(reEnriched.map((r) => [r.id, r]));
      let updatedCount = 0;
      for (let i = 0; i < existingThreads.length; i++) {
        const updated = reEnrichedMap.get(existingThreads[i].id);
        if (updated) {
          const patch = {};
          if (updated.summary) patch.summary = updated.summary;
          if (updated.concepts && updated.concepts.length > 0) patch.concepts = updated.concepts;
          if (updated.difficulty) patch.difficulty = updated.difficulty;
          if (updated.category && updated.category !== "General" && updated.category !== "Unknown") patch.category = updated.category;
          if (Object.keys(patch).length > 0) {
            existingThreads[i] = { ...existingThreads[i], ...patch };
            updatedCount++;
          }
        }
      }
      console.log(`Re-enriched ${updatedCount} previously stale items`);
    }

    // 5. Merge with existing threads
    const allThreads = [...existingThreads, ...enrichedNew];

    // 6. Rebuild concepts list (no Claude call needed — fast)
    const conceptMap = {};
    for (const t of allThreads) {
      for (const c of t.concepts || []) {
        const key = c.toLowerCase().trim();
        if (!conceptMap[key]) conceptMap[key] = { name: c, thread_ids: new Set() };
        conceptMap[key].thread_ids.add(t.id);
      }
    }
    const conceptsList = Object.values(conceptMap)
      .filter((c) => c.thread_ids.size >= 2)
      .map((c) => ({ name: c.name, thread_ids: [...c.thread_ids], description: "" }))
      .sort((a, b) => b.thread_ids.length - a.thread_ids.length);

    // 7. Generate quizzes BEFORE connections (quizzes are user-facing, connections can wait)
    let quizzes = existing.quizzes || [];
    const existingQuizThreadIds = new Set(quizzes.map((q) => q.thread_id));
    const itemsNeedingQuizzes = [
      ...enrichedNew.filter((t) => t.summary),
      ...reEnriched.filter((t) => t.summary && !existingQuizThreadIds.has(t.id)),
      ...allThreads.filter((t) => t.summary && !existingQuizThreadIds.has(t.id) && !enrichedNew.some((n) => n.id === t.id) && !reEnriched.some((r) => r.id === t.id)),
    ].slice(0, BATCH_LIMIT);

    const timeLeftForQuizzes = TIME_BUDGET_MS - (Date.now() - startTime);
    if (timeLeftForQuizzes < 8000) {
      console.log(`Skipping quizzes — only ${timeLeftForQuizzes}ms left (need ~8s). Will generate on next refresh.`);
    } else if (itemsNeedingQuizzes.length === 0) {
      console.log("All items already have quizzes.");
    } else {
      console.log(`Generating quizzes for ${itemsNeedingQuizzes.length} items (${timeLeftForQuizzes}ms remaining)...`);
      try {
        // Only generate item-based quizzes here (skip edge quizzes to save time)
        const newQuizzes = await generateQuizzes(client, itemsNeedingQuizzes, []);
        quizzes = [...quizzes, ...newQuizzes];
        console.log(`Generated ${newQuizzes.length} new quiz questions`);
      } catch (e) {
        console.log(`Quiz generation error: ${e.message}`);
      }
    }

    // 8. Re-generate connections on full dataset (skip if running low on time)
    let connections;
    const timeLeftForConnections = TIME_BUDGET_MS - (Date.now() - startTime);
    if (timeLeftForConnections < 10000) {
      console.log(`Skipping connections — only ${timeLeftForConnections}ms left (need ~10s)`);
      connections = {
        edges: existing.edges || [],
        clusters: existing.clusters || [],
        learning_paths: existing.learning_paths || [],
      };
    } else {
      console.log(`Regenerating connections for ${allThreads.length} items (${timeLeftForConnections}ms remaining)...`);
      try {
        connections = await generateConnections(client, allThreads);
      } catch (e) {
        console.log(`Connections error: ${e.message}`);
        connections = {
          edges: existing.edges || [],
          clusters: existing.clusters || [],
          learning_paths: existing.learning_paths || [],
        };
      }
    }

    // 9. Assign clusters (use category as fallback instead of "General")
    const clusterLookup = {};
    for (const cluster of connections.clusters || []) {
      for (const tid of cluster.thread_ids || []) {
        clusterLookup[tid] = cluster.name;
      }
    }
    for (const t of allThreads) {
      const fromCluster = clusterLookup[t.id];
      if (fromCluster) {
        t.cluster = fromCluster;
      } else if (!t.cluster || t.cluster === "General") {
        // Use category as a better fallback than "General"
        t.cluster = t.category && t.category !== "Unknown" && t.category !== "General" ? t.category : t.cluster || "General";
      }
    }

    // 9.5 Ensure every cluster name used by threads has an entry in the clusters array
    const clusterColors = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac"];
    const existingClusterNames = new Set((connections.clusters || []).map((c) => c.name));
    const missingClusters = {};
    for (const t of allThreads) {
      if (t.cluster && !existingClusterNames.has(t.cluster)) {
        if (!missingClusters[t.cluster]) missingClusters[t.cluster] = [];
        missingClusters[t.cluster].push(t.id);
      }
    }
    const finalClusters = [...(connections.clusters || [])];
    let colorIdx = finalClusters.length;
    for (const [name, threadIds] of Object.entries(missingClusters)) {
      finalClusters.push({
        name,
        color: clusterColors[colorIdx % clusterColors.length],
        thread_ids: threadIds,
        description: `Auto-generated cluster from category: ${name}`,
      });
      colorIdx++;
    }

    // 10. Build final output
    const output = {
      threads: allThreads,
      concepts: conceptsList,
      edges: connections.edges || [],
      learning_paths: connections.learning_paths || [],
      clusters: finalClusters,
      quizzes,
    };

    // 11. Save to Vercel Blob
    await put(`mindmap-data/${blobKey}.json`, JSON.stringify(output), {
      contentType: "application/json",
      access: "public",
      addRandomSuffix: false,
    });

    const remaining = totalNewAvailable - enrichedNew.length;
    const reEnrichedCount = reEnriched.filter((r) => r.summary).length;
    const enrichedNewSuccess = enrichedNew.filter((r) => r.summary).length;
    const parts = [];
    if (enrichedNew.length > 0) parts.push(`Added ${enrichedNew.length} new (${enrichedNewSuccess} enriched)`);
    if (reEnrichedCount > 0) parts.push(`re-enriched ${reEnrichedCount} existing`);
    parts.push(`Total: ${allThreads.length}`);
    if (remaining > 0) parts.push(`${remaining} more available — refresh again`);
    const staleRemaining = allThreads.filter((t) => needsEnrichment(t) || needsCategory(t)).length;
    if (staleRemaining > 0) parts.push(`${staleRemaining} still need enrichment`);
    if (enrichErrors.length > 0) parts.push(`Enrichment errors: ${enrichErrors.slice(0, 3).join("; ")}`);

    return res.status(200).json({
      success: true,
      newCount: enrichedNew.length,
      totalCount: allThreads.length,
      remaining,
      enrichedCount: enrichedNewSuccess + reEnrichedCount,
      enrichErrors: enrichErrors.length,
      message: parts.join(". ") + ".",
    });
  } catch (e) {
    console.error("Refresh error:", e);
    return res.status(500).json({ error: e.message });
  }
}
