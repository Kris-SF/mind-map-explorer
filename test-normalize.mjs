import { readFileSync } from "fs";
import { normalizeCategory, normalizeDataset, CANONICAL_CATEGORIES } from "./api/categories.js";

const d = JSON.parse(readFileSync("./data/moontower_enriched.json", "utf8"));

console.log("=== BEFORE ===");
console.log(`Clusters: ${d.clusters.length}`);
for (const c of d.clusters) {
  console.log(`  ${c.name} (${c.thread_ids?.length} threads)`);
}
console.log(`Unique thread.cluster values: ${[...new Set(d.threads.map(t => t.cluster))].length}`);

const changed = normalizeDataset(d);

console.log(`\n=== AFTER (${changed} fields changed) ===`);
console.log(`Clusters: ${d.clusters.length}`);
for (const c of d.clusters) {
  console.log(`  ${c.name} (${c.thread_ids?.length} threads)`);
}

console.log(`\nThread cluster distribution:`);
const finalClusters = [...new Set(d.threads.map(t => t.cluster))].sort();
for (const v of finalClusters) {
  console.log(`  ${v} - ${d.threads.filter(t => t.cluster === v).length} threads`);
}

// Verify all canonical categories are covered
console.log(`\nCanonical coverage:`);
for (const cat of CANONICAL_CATEGORIES) {
  const count = d.threads.filter(t => t.category === cat).length;
  console.log(`  ${count > 0 ? "OK" : "EMPTY"} ${cat}: ${count} threads`);
}
