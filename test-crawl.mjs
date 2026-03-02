// Diagnostic script — run with: node test-crawl.mjs
// Tests both blog.moontower.ai and moontower.substack.com crawling

import * as cheerio from "cheerio";

const UA = "Mozilla/5.0 (compatible; MindMapBot/1.0)";

async function tryFetch(label, url) {
  console.log(`\n--- ${label} ---`);
  console.log(`GET ${url}`);
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(15000),
      redirect: "follow",
    });
    console.log(`Status: ${resp.status} ${resp.statusText}`);
    console.log(`Content-Type: ${resp.headers.get("content-type")}`);
    console.log(`Final URL: ${resp.url}`);
    const text = await resp.text();
    console.log(`Body length: ${text.length} chars`);
    return { ok: resp.ok, status: resp.status, text, finalUrl: resp.url };
  } catch (e) {
    console.log(`ERROR: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function testBlog() {
  console.log("\n========== BLOG.MOONTOWER.AI ==========");

  // Test 1: homepage — what platform is this?
  const home = await tryFetch("Blog homepage", "https://blog.moontower.ai/");
  if (home.ok) {
    const $ = cheerio.load(home.text);
    const generator = $('meta[name="generator"]').attr("content") || "(none)";
    console.log(`Generator meta: ${generator}`);
    // Check if it's actually Substack
    const isSubstack = home.text.includes("substack") || home.text.includes("substackcdn");
    console.log(`Looks like Substack? ${isSubstack}`);
    const isGhost = home.text.includes("ghost") || generator.toLowerCase().includes("ghost");
    console.log(`Looks like Ghost? ${isGhost}`);
    // Count links that look like posts
    const links = [];
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (href && href.startsWith("https://blog.moontower.ai/") && !href.includes("/tag/") && !href.includes("/author/")) {
        links.push(href);
      }
    });
    console.log(`Post-like links on homepage: ${[...new Set(links)].length}`);
    [...new Set(links)].slice(0, 5).forEach((l) => console.log(`  ${l}`));
  }

  // Test 2: sitemap-posts.xml (Ghost-style)
  const sitemap1 = await tryFetch("sitemap-posts.xml", "https://blog.moontower.ai/sitemap-posts.xml");
  if (sitemap1.ok) {
    const $ = cheerio.load(sitemap1.text, { xmlMode: true });
    const urls = [];
    $("url loc").each((_, el) => urls.push($(el).text().trim()));
    console.log(`URLs in sitemap-posts.xml: ${urls.length}`);
    urls.slice(0, 5).forEach((u) => console.log(`  ${u}`));
  }

  // Test 3: sitemap.xml
  const sitemap2 = await tryFetch("sitemap.xml", "https://blog.moontower.ai/sitemap.xml");
  if (sitemap2.ok) {
    const $ = cheerio.load(sitemap2.text, { xmlMode: true });
    const sitemapUrls = [];
    $("sitemap loc").each((_, el) => sitemapUrls.push($(el).text().trim()));
    const urlEntries = [];
    $("url loc").each((_, el) => urlEntries.push($(el).text().trim()));
    console.log(`Sub-sitemaps: ${sitemapUrls.length}`);
    sitemapUrls.forEach((u) => console.log(`  ${u}`));
    console.log(`Direct URL entries: ${urlEntries.length}`);
    urlEntries.slice(0, 5).forEach((u) => console.log(`  ${u}`));
  }

  // Test 4: Substack archive API (in case blog.moontower.ai IS a Substack custom domain)
  const ssApi = await tryFetch(
    "Substack API on blog domain",
    "https://blog.moontower.ai/api/v1/archive?sort=new&limit=2&offset=0"
  );
  if (ssApi.ok) {
    try {
      const posts = JSON.parse(ssApi.text);
      console.log(`Substack API works on blog domain! Got ${posts.length} posts`);
      posts.forEach((p) => console.log(`  ${p.title} (${p.slug})`));
    } catch {
      console.log("Response is not JSON");
    }
  }

  // Test 5: RSS feed
  const rss = await tryFetch("RSS feed", "https://blog.moontower.ai/rss/");
  if (rss.ok) {
    const $ = cheerio.load(rss.text, { xmlMode: true });
    const items = [];
    $("item title").each((_, el) => items.push($(el).text().trim()));
    console.log(`RSS items: ${items.length}`);
    items.slice(0, 5).forEach((t) => console.log(`  ${t}`));
  }
}

async function testSubstack() {
  console.log("\n========== MOONTOWER.SUBSTACK.COM ==========");

  // Test 1: archive API
  const api = await tryFetch(
    "Substack archive API",
    "https://moontower.substack.com/api/v1/archive?sort=new&limit=3&offset=0"
  );
  if (api.ok) {
    try {
      const posts = JSON.parse(api.text);
      console.log(`Got ${posts.length} posts`);
      posts.forEach((p) => {
        console.log(`  id=${p.id} title="${p.title}" slug="${p.slug}"`);
        console.log(`    canonical_url=${p.canonical_url}`);
        console.log(`    has body_html: ${!!p.body_html} (${(p.body_html || "").length} chars)`);
        console.log(`    post_date=${p.post_date} type=${p.type}`);
      });
    } catch (e) {
      console.log(`JSON parse error: ${e.message}`);
      console.log(`First 500 chars: ${api.text.slice(0, 500)}`);
    }
  }

  // Test 2: check if no UA still works
  console.log("\n--- Substack API without User-Agent ---");
  try {
    const resp = await fetch(
      "https://moontower.substack.com/api/v1/archive?sort=new&limit=1&offset=0",
      { signal: AbortSignal.timeout(10000) }
    );
    console.log(`Status without UA: ${resp.status}`);
  } catch (e) {
    console.log(`Error without UA: ${e.message}`);
  }
}

async function main() {
  console.log("=== Mind Map Crawl Diagnostics ===");
  console.log(`User-Agent: ${UA}`);
  console.log(`Node: ${process.version}`);
  console.log(`Time: ${new Date().toISOString()}`);

  await testBlog();
  await testSubstack();

  console.log("\n=== Done ===");
}

main().catch(console.error);
