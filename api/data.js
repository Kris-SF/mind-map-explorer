import { list } from "@vercel/blob";
import { readFileSync } from "fs";
import { join } from "path";
import { normalizeDataset } from "./categories.js";

const VALID_DATASETS = { moontower: "moontower_enriched" };

export default async function handler(req, res) {
  const dataset = req.query.dataset || "moontower";

  if (!VALID_DATASETS[dataset]) {
    return res.status(400).json({ error: "Invalid dataset. Use moontower." });
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
      console.log("Blob storage unavailable, falling back to static files:", e.message);
    }
  }

  // Fallback: read from static data/ directory
  if (!data) {
    try {
      const filePath = join(process.cwd(), "data", `${blobKey}.json`);
      const fileData = readFileSync(filePath, "utf-8");
      data = JSON.parse(fileData);
    } catch (e) {
      return res.status(404).json({ error: "Data not found" });
    }
  }

  // Always normalize categories/clusters before serving
  normalizeDataset(data);

  res.setHeader("Cache-Control", "public, max-age=60");
  return res.status(200).json(data);
}
