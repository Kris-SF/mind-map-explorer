/**
 * Fetch all published posts from Beehiiv and write a static
 * data/cultishcreative_enriched.json — no Anthropic key needed.
 *
 * Usage:
 *   BEEHIIV_API_KEY=<your_key> node scripts/seed-beehiiv.mjs
 *
 * Then commit data/cultishcreative_enriched.json.
 */

import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const API_KEY = process.env.BEEHIIV_API_KEY;
if (!API_KEY) {
  console.error("Error: BEEHIIV_API_KEY is not set.");
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));

async function get(url) {
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText} — ${url}`);
  return resp.json();
}

async function getPublicationId() {
  const { data } = await get("https://api.beehiiv.com/v2/publications");
  if (!data || data.length === 0) throw new Error("No publications found for this API key.");
  console.log(`Found publication: ${data[0].name} (${data[0].id})`);
  return data[0].id;
}

async function fetchAllPosts(pubId) {
  const posts = [];
  let page = 1;
  const limit = 100;

  while (true) {
    const url =
      `https://api.beehiiv.com/v2/publications/${pubId}/posts` +
      `?limit=${limit}&page=${page}&status=confirmed` +
      `&expand[]=free_email_content`;
    const { data } = await get(url);
    if (!data || data.length === 0) break;
    posts.push(...data);
    console.log(`  Fetched page ${page} — ${posts.length} posts so far`);
    if (data.length < limit) break;
    page++;
  }

  return posts;
}

function stripHtml(html) {
  return (html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugToId(slug, index) {
  return `cc_${index + 1}`;
}

function inferCategory(post) {
  // Use subtitle if present, otherwise fall back to "General"
  return post.subtitle ? post.subtitle.trim() : "General";
}

function buildDataset(posts) {
  const threads = posts.map((p, i) => {
    const text = stripHtml(p.free_email_content).slice(0, 500);
    return {
      id: slugToId(p.slug || p.id, i),
      title: p.title || "Untitled",
      url: p.web_url || "",
      category: inferCategory(p),
      cluster: inferCategory(p),
      summary: text ? text + (text.length === 500 ? "…" : "") : "",
      concepts: [],
      difficulty: "intermediate",
      publishedAt: p.publish_date
        ? new Date(p.publish_date * 1000).toISOString()
        : null,
    };
  });

  // Build simple clusters from categories
  const clusterMap = new Map();
  const colors = [
    "#4e79a7","#f28e2b","#e15759","#76b7b2","#59a14f",
    "#edc948","#b07aa1","#ff9da7","#9c755f","#bab0ac",
  ];
  let colorIdx = 0;
  for (const t of threads) {
    const name = t.cluster || "General";
    if (!clusterMap.has(name)) {
      clusterMap.set(name, {
        name,
        color: colors[colorIdx++ % colors.length],
        thread_ids: [],
        description: "",
      });
    }
    clusterMap.get(name).thread_ids.push(t.id);
  }

  return {
    threads,
    concepts: [],
    edges: [],
    learning_paths: [],
    clusters: [...clusterMap.values()],
    quizzes: [],
  };
}

(async () => {
  try {
    console.log("Fetching publication ID…");
    const pubId = await getPublicationId();

    console.log("Fetching posts…");
    const posts = await fetchAllPosts(pubId);
    console.log(`Total posts: ${posts.length}`);

    const dataset = buildDataset(posts);
    const outPath = join(__dirname, "..", "data", "cultishcreative_enriched.json");
    writeFileSync(outPath, JSON.stringify(dataset, null, 2));
    console.log(`\nWrote ${posts.length} posts → ${outPath}`);
    console.log("Done! Now: git add data/cultishcreative_enriched.json && git commit -m 'seed cultishcreative data'");
  } catch (e) {
    console.error("Failed:", e.message);
    process.exit(1);
  }
})();
