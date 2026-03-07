export const CANONICAL_CATEGORIES = [
  "Options & Volatility",
  "Probability & Decision-Making",
  "Risk Management & Portfolio Theory",
  "Market Microstructure & Trading",
  "Behavioral Finance & Psychology",
  "Career & Professional Development",
  "Personal Finance & Investing",
  "Commentary & Market Analysis",
];

// Map any free-form category/cluster name to the closest canonical one
const CATEGORY_MAP = {
  // Options-related
  "options and volatility": "Options & Volatility",
  "options pricing & greeks": "Options & Volatility",
  "options theory & mechanics": "Options & Volatility",
  "volatility trading & surface": "Options & Volatility",
  "volatility drag & compounding": "Options & Volatility",
  "advanced volatility trading & surface": "Options & Volatility",
  "series on option greeks": "Options & Volatility",
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

export function normalizeCategory(raw) {
  if (!raw) return null;
  const key = raw.toLowerCase().trim();
  if (CATEGORY_MAP[key]) return CATEGORY_MAP[key];
  const canonical = CANONICAL_CATEGORIES.find((c) => c.toLowerCase() === key);
  if (canonical) return canonical;
  return null;
}

/**
 * Normalize all categories and clusters in a dataset in-place.
 * Returns the number of fields changed.
 */
export function normalizeDataset(data) {
  let changed = 0;

  // Normalize thread categories and clusters
  for (const t of data.threads || []) {
    const normCat = normalizeCategory(t.category);
    if (normCat && normCat !== t.category) {
      t.category = normCat;
      changed++;
    }
    const normCluster = normalizeCategory(t.cluster);
    if (normCluster && normCluster !== t.cluster) {
      t.cluster = normCluster;
      changed++;
    }
  }

  // Merge clusters with same canonical name
  if (data.clusters) {
    const mergedClusters = new Map();
    for (const c of data.clusters) {
      const normName = normalizeCategory(c.name) || c.name;
      if (mergedClusters.has(normName)) {
        const existing = mergedClusters.get(normName);
        const ids = new Set([...existing.thread_ids, ...c.thread_ids]);
        existing.thread_ids = [...ids];
      } else {
        mergedClusters.set(normName, { ...c, name: normName });
      }
    }
    data.clusters = [...mergedClusters.values()];
  }

  return changed;
}
