import { list } from "@vercel/blob";
import { readFileSync } from "fs";
import { join } from "path";

const VALID_DATASETS = { moontower: "moontower_enriched", substack: "substack_enriched", blog: "blog_enriched" };

export default async function handler(req, res) {
  const dataset = req.query.dataset || "moontower";

  if (!VALID_DATASETS[dataset]) {
    return res.status(400).json({ error: "Invalid dataset. Use moontower, substack, or blog." });
  }

  const blobKey = VALID_DATASETS[dataset];

  // Try Vercel Blob first
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      const { blobs } = await list({ prefix: `mindmap-data/${blobKey}` });
      if (blobs.length > 0) {
        const resp = await fetch(blobs[0].downloadUrl);
        const data = await resp.json();
        res.setHeader("Cache-Control", "public, max-age=60");
        return res.status(200).json(data);
      }
    } catch (e) {
      console.log("Blob storage unavailable, falling back to static files:", e.message);
    }
  }

  // Fallback: read from static data/ directory
  try {
    const filePath = join(process.cwd(), "data", `${blobKey}.json`);
    const fileData = readFileSync(filePath, "utf-8");
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.status(200).json(JSON.parse(fileData));
  } catch (e) {
    return res.status(404).json({ error: "Data not found" });
  }
}
