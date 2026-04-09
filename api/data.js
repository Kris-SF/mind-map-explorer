import { list } from "@vercel/blob";
import { readFileSync } from "fs";
import { join } from "path";
import { normalizeDataset } from "./categories.js";

const VALID_DATASETS = {
  moontower: "moontower_enriched",
  cultishcreative: "cultishcreative_enriched",
};

// ── Beehiiv live fetch (no enrichment, no Blob, no Anthropic needed) ──────────

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

async function beehiivGet(path) {
  const resp = await fetch(`https://api.beehiiv.com/v2${path}`, {
    headers: { Authorization: `Bearer ${process.env.BEEHIIV_API_KEY}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`Beehiiv API error: HTTP ${resp.status}`);
  return resp.json();
}

async function fetchBeehiivLive() {
  // Discover publication
  const { data: pubs } = await beehiivGet("/publications");
  if (!pubs || pubs.length === 0) throw new Error("No Beehiiv publications found");
  const pubId = pubs[0].id;

  // Fetch all published posts
  const posts = [];
  let page = 1;
  while (true) {
    const { data } = await beehiivGet(
      `/publications/${pubId}/posts?limit=100&page=${page}&status=confirmed&expand[]=free_email_content`
    );
    if (!data || data.length === 0) break;
    posts.push(...data);
    if (data.length < 100) break;
    page++;
  }

  // Format into the shape the mind-map-explorer expects
  const colors = [
    "#4e79a7","#f28e2b","#e15759","#76b7b2","#59a14f",
    "#edc948","#b07aa1","#ff9da7","#9c755f","#bab0ac",
  ];
  const threads = posts.map((p, i) => {
    const preview = stripHtml(p.free_email_content).slice(0, 500);
    const category = p.subtitle ? p.subtitle.trim() : "General";
    return {
      id: `cc_${i + 1}`,
      title: p.title || "Untitled",
      url: p.web_url || "",
      category,
      cluster: category,
      summary: preview ? preview + (preview.length === 500 ? "…" : "") : "",
      concepts: [],
      difficulty: "intermediate",
      publishedAt: p.publish_date
        ? new Date(p.publish_date * 1000).toISOString()
        : null,
    };
  });

  // Build clusters
  const clusterMap = new Map();
  let colorIdx = 0;
  for (const t of threads) {
    if (!clusterMap.has(t.cluster)) {
      clusterMap.set(t.cluster, {
        name: t.cluster,
        color: colors[colorIdx++ % colors.length],
        thread_ids: [],
        description: "",
      });
    }
    clusterMap.get(t.cluster).thread_ids.push(t.id);
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

// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const dataset = req.query.dataset || "moontower";

  if (!VALID_DATASETS[dataset]) {
    return res.status(400).json({ error: "Invalid dataset." });
  }

  const blobKey = VALID_DATASETS[dataset];
  let data = null;

  // Try Vercel Blob first
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      const { blobs } = await list({ prefix: `mindmap-data/${blobKey}` });
      if (blobs.length > 0) {
        const resp = await fetch(blobs[0].downloadUrl);
        data = await resp.json();
      }
    } catch (e) {
      console.log("Blob storage unavailable, falling back:", e.message);
    }
  }

  // For cultishcreative: fetch live from Beehiiv if no blob data
  if (!data && dataset === "cultishcreative" && process.env.BEEHIIV_API_KEY) {
    try {
      data = await fetchBeehiivLive();
      res.setHeader("Cache-Control", "public, max-age=300"); // cache 5 min
      return res.status(200).json(data);
    } catch (e) {
      console.log("Beehiiv live fetch failed:", e.message);
    }
  }

  // Fallback: read from static data/ directory
  if (!data) {
    try {
      const filePath = join(process.cwd(), "data", `${blobKey}.json`);
      data = JSON.parse(readFileSync(filePath, "utf-8"));
    } catch (e) {
      return res.status(404).json({ error: "Data not found" });
    }
  }

  // Normalize categories/clusters (Moontower-specific)
  if (dataset === "moontower") normalizeDataset(data);

  res.setHeader("Cache-Control", "public, max-age=60");
  return res.status(200).json(data);
}
