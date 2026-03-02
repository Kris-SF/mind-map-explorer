import { getStore } from "@netlify/blobs";
import { readFile } from "fs/promises";
import { join } from "path";

const VALID_DATASETS = { moontower: "moontower_enriched", substack: "substack_enriched", blog: "blog_enriched" };

export default async (req, context) => {
  const url = new URL(req.url);
  const dataset = url.searchParams.get("dataset") || "moontower";

  if (!VALID_DATASETS[dataset]) {
    return new Response(JSON.stringify({ error: "Invalid dataset. Use moontower, substack, or blog." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const blobKey = VALID_DATASETS[dataset];

  try {
    // Try Netlify Blobs first
    const store = getStore("mindmap-data");
    const data = await store.get(blobKey, { type: "json" });
    if (data) {
      return new Response(JSON.stringify(data), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=60",
        },
      });
    }
  } catch (e) {
    console.log("Blobs unavailable or empty, falling back to static files:", e.message);
  }

  // Fallback: read from static data/ directory
  try {
    const filePath = join(process.cwd(), "data", `${blobKey}.json`);
    const fileData = await readFile(filePath, "utf-8");
    return new Response(fileData, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=60",
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "Data not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
};
