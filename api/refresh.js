import { list, put } from "@vercel/blob";
import Anthropic from "@anthropic-ai/sdk";
import * as cheerio from "cheerio";
import { readFileSync } from "fs";
import { join } from "path";

const VALID_DATASETS = { moontower: "moontower_enriched" };
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

const CANONICAL_CATEGORIES = [
  "Options & Volatility",
  "Probability & Decision-Making",
  "Risk Management & Portfolio Theory",
  "Market Microstructure & Trading",
  "Behavioral Finance & Psychology",
  "Career & Professional Development",
  "Personal Finance & Investing",
  "Commentary & Market Analysis",
];

// Map any free-form category to the closest canonical one
const CATEGORY_MAP = {
  // Options-related
  "options and volatility": "Options & Volatility",
  "options pricing & greeks": "Options & Volatility",
  "options theory & mechanics": "Options & Volatility",
  "volatility trading & surface": "Options & Volatility",
  "volatility drag & compounding": "Options & Volatility",
  "advanced volatility trading & surface": "Options & Volatility",
  "series on option greeks": "Options & Volatility",
  "options and volatility": "Options & Volatility",
  "shorting & leverage": "Options & Volatility",
  // Probability / decision-making
  "probability & decision making": "Probability & Decision-Making",
  "probability, calibration & statistics": "Probability & Decision-Making",
  "probability & statistics": "Probability & Decision-Making",
  "decision-making & expected value": "Probability & Decision-Making",
  "numeracy & decision-making": "Probability & Decision-Making",
  "core math & risk fundamentals": "Probability & Decision-Making",
  "compounding & growth": "Probability & Decision-Making",
  // Risk / portfolio
  "risk management & portfolio theory": "Risk Management & Portfolio Theory",
  "portfolio construction & risk management": "Risk Management & Portfolio Theory",
  "portfolio theory & risk management": "Risk Management & Portfolio Theory",
  "portfolio theory": "Risk Management & Portfolio Theory",
  "risk and the math of returns": "Risk Management & Portfolio Theory",
  "portfolio theory and life": "Risk Management & Portfolio Theory",
  "portfolio theory is not intuitive": "Risk Management & Portfolio Theory",
  "valuation & capital allocation": "Risk Management & Portfolio Theory",
  // Market micro
  "market microstructure & trading": "Market Microstructure & Trading",
  "market microstructure": "Market Microstructure & Trading",
  "market structure & efficiency": "Market Microstructure & Trading",
  "the meta of market efficiency": "Market Microstructure & Trading",
  "finding edges": "Market Microstructure & Trading",
  // Behavioral
  "behavioral finance & psychology": "Behavioral Finance & Psychology",
  // Career
  "career & professional development": "Career & Professional Development",
  "career, finance careers & education": "Career & Professional Development",
  "career & trader development": "Career & Professional Development",
  "training, interviews, & career": "Career & Professional Development",
  "notes on interviews": "Career & Professional Development",
  // Personal finance
  "personal finance & investing": "Personal Finance & Investing",
  "personal finance & life decisions": "Personal Finance & Investing",
  "investing & personal finance": "Personal Finance & Investing",
  "investing": "Personal Finance & Investing",
  "real estate and property": "Personal Finance & Investing",
  "wealth and mindset": "Personal Finance & Investing",
  // Commentary
  "commentary & market analysis": "Commentary & Market Analysis",
  "market commentary & life philosophy": "Commentary & Market Analysis",
  "commentary": "Commentary & Market Analysis",
  "reading recs": "Commentary & Market Analysis",
};

function normalizeCategory(raw) {
  if (!raw) return null;
  const key = raw.toLowerCase().trim();
  if (CATEGORY_MAP[key]) return CATEGORY_MAP[key];
  // Check if it's already canonical
  const canonical = CANONICAL_CATEGORIES.find((c) => c.toLowerCase() === key);
  if (canonical) return canonical;
  return null;
}

async function enrichSingleItem(client, item) {
  let content = (item.text || "").slice(0, 8000);
  if (!content.trim()) content = `(No content. Title: ${item.title})`;
  const categoryList = CANONICAL_CATEGORIES.map((c) => `"${c}"`).join(", ");
  const prompt = `Analyze this article by Kris Abdelmessih (Moontower) about finance, options, volatility, or decision-making.

Title: ${item.title}

Article content:
${content}

Assign EXACTLY ONE category from this list: ${categoryList}
You MUST pick one of these exact strings. Do not invent new categories.

Return JSON (no markdown fences):
{
  "summary": "2-3 sentence summary of the article's key message",
  "concepts": ["list", "of", "key", "concepts"],
  "difficulty": "beginner|intermediate|advanced",
  "category": "one of the exact categories from the list above"
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

    // Normalize existing categories to canonical names where possible
    for (const t of existingThreads) {
      const norm = normalizeCategory(t.category);
      if (norm) t.category = norm;
    }

    // 2. Scrape for new items (batched — returns up to BATCH_LIMIT)
    const existingUrls = new Set(existingThreads.map((t) => t.url));
    const newRawItems = await scrapeMoontowerNew(existingUrls);
    let totalNewAvailable = newRawItems.length;

    // Check if there are stale items that need re-enrichment (missing summary/concepts OR non-canonical category)
    const needsCategory = (t) => !normalizeCategory(t.category);
    const needsEnrichment = (t) => !t.summary || !t.concepts || t.concepts.length === 0;
    const staleCount = existingThreads.filter((t) => needsEnrichment(t) || needsCategory(t)).length;
    if (newRawItems.length === 0 && staleCount === 0) {
      return res.status(200).json({ success: true, newCount: 0, message: "No new articles found. All existing articles are enriched." });
    }

    // 3. Assign IDs to new articles
    const maxId = Math.max(0, ...existingThreads.map((t) => parseInt(t.id.replace("mt_", "")) || 0));
    newRawItems.forEach((item, i) => {
      item.id = `mt_${maxId + i + 1}`;
    });

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
          category: normalizeCategory(meta.category) || normalizeCategory(item.category) || meta.category || "Commentary & Market Analysis",
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
          if (updated.category && normalizeCategory(updated.category)) patch.category = normalizeCategory(updated.category);
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
