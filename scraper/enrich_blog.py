"""
AI Enrichment: Process raw blog.moontower.ai posts with Gemini API to generate:
- Summaries, key concepts, difficulty levels
- Cross-post connections, clusters, learning paths
- Quiz questions
Output: data/blog_enriched.json
"""

import json
import os
import sys
import time
from pathlib import Path

from google import genai

RAW_PATH = Path(__file__).parent.parent / "data" / "blog_raw.json"
OUTPUT = Path(__file__).parent.parent / "data" / "blog_enriched.json"

client = genai.Client()  # reads GEMINI_API_KEY or GOOGLE_API_KEY env var
MODEL = "gemini-2.5-flash"


def strip_fences(text):
    """Remove markdown code fences from response."""
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1]
    if text.endswith("```"):
        text = text[:-3]
    return text.strip()


def enrich_single_post(post):
    """Get summary, concepts, difficulty for one post."""
    body = post["text"][:8000]
    if not body.strip():
        body = f"(No content available. Title: {post['title']})"

    prompt = f"""Analyze this blog post from blog.moontower.ai by Kris Abdelmessih about options analytics, volatility, or trading.

Title: {post['title']}

Post content:
{body}

Return JSON (no markdown fences):
{{
  "summary": "2-3 sentence summary of the post's key message",
  "concepts": ["list", "of", "key", "concepts", "mentioned"],
  "difficulty": "beginner|intermediate|advanced",
  "concept_descriptions": {{"concept_name": "one-line description"}}
}}"""

    resp = client.models.generate_content(model=MODEL, contents=prompt)
    text = strip_fences(resp.text)
    return json.loads(text)


def generate_connections(posts_with_meta):
    """Second pass: generate cross-post connections, clusters, and learning paths."""
    post_summaries = []
    for p in posts_with_meta:
        post_summaries.append(
            f"ID: {p['id']}\nTitle: {p['title']}\n"
            f"Summary: {p.get('summary', 'N/A')}\n"
            f"Concepts: {', '.join(p.get('concepts', []))}\n"
            f"Difficulty: {p.get('difficulty', 'N/A')}"
        )

    all_summaries_text = "\n\n".join(post_summaries)

    prompt = f"""You have {len(posts_with_meta)} blog posts from blog.moontower.ai by Kris Abdelmessih covering options analytics, volatility surfaces, trading tools, and related topics.

Here are all posts:

{all_summaries_text}

Analyze the relationships between these posts and return JSON (no markdown fences):
{{
  "edges": [
    {{"source": "post_id", "target": "post_id", "type": "builds_on|contrasts_with|applies_concept_from|prerequisite_for", "strength": 0.1-1.0, "reason": "brief explanation"}}
  ],
  "clusters": [
    {{"name": "Cluster Name", "color": "#hexcolor", "thread_ids": ["id1", "id2"], "description": "what this cluster covers"}}
  ],
  "learning_paths": [
    {{"name": "Path Name", "description": "who this path is for", "thread_ids": ["id1", "id2", "...in reading order"]}}
  ]
}}

Guidelines:
- Create 4-8 topic clusters based on the actual content (e.g., volatility surface, options analytics, market microstructure, trading tools, risk management)
- Create 2-4 learning paths
- Include 20-40 edges capturing the most meaningful connections
- Every post should belong to exactly one cluster
- Use these colors for clusters: #4e79a7, #f28e2b, #e15759, #76b7b2, #59a14f, #edc948, #b07aa1, #ff9da7"""

    resp = client.models.generate_content(model=MODEL, contents=prompt)
    text = strip_fences(resp.text)
    return json.loads(text)


def generate_quizzes(posts, edges):
    """Pass 3: Generate quiz questions for spaced repetition."""
    quizzes = []

    batch_size = 10
    for batch_start in range(0, len(posts), batch_size):
        batch = posts[batch_start:batch_start + batch_size]
        post_block = "\n\n".join(
            f"ID: {p['id']}\nTitle: {p['title']}\nSummary: {p.get('summary', 'N/A')}\n"
            f"Concepts: {', '.join(p.get('concepts', []))}\nDifficulty: {p.get('difficulty', 'intermediate')}"
            for p in batch
        )

        prompt = f"""Generate quiz questions for these blog posts from blog.moontower.ai about options analytics and volatility.

{post_block}

For EACH post, generate exactly 2 questions:
1. A concept_recall question (open-ended, tests understanding of the key idea)
2. A multiple_choice question (4 choices, tests specific knowledge)

Return JSON array (no markdown fences):
[
  {{
    "id": "q_<post_id>_0",
    "thread_id": "<post_id>",
    "type": "concept_recall",
    "question": "...",
    "answer": "...",
    "difficulty": "beginner|intermediate|advanced",
    "concepts": ["concept1", "concept2"]
  }},
  {{
    "id": "q_mc_<post_id>_0",
    "thread_id": "<post_id>",
    "type": "multiple_choice",
    "question": "...",
    "choices": ["A) ...", "B) ...", "C) ...", "D) ..."],
    "correct_index": 0,
    "explanation": "...",
    "difficulty": "beginner|intermediate|advanced",
    "concepts": ["concept1", "concept2"]
  }}
]

Make questions test genuine understanding, not just memorization."""

        try:
            resp = client.models.generate_content(model=MODEL, contents=prompt)
            text = strip_fences(resp.text)
            batch_quizzes = json.loads(text)
            quizzes.extend(batch_quizzes)
        except Exception as e:
            print(f"  Quiz batch error: {e}")
        time.sleep(0.5)

    # Connection questions from edges
    edge_batch_size = 20
    for batch_start in range(0, len(edges), edge_batch_size):
        batch = edges[batch_start:batch_start + edge_batch_size]
        title_map = {p['id']: p['title'] for p in posts}
        edge_context = "\n".join(
            f"{title_map.get(e['source'], e['source'])} -> {title_map.get(e['target'], e['target'])}: {e.get('reason', 'N/A')}"
            for e in batch
        )

        prompt = f"""Generate 1 connection quiz question per edge. These edges connect blog posts about options analytics and volatility.

Edges:
{edge_context}

For each edge, generate a question testing understanding of how the two topics connect.

Return JSON array (no markdown fences):
[
  {{
    "id": "q_edge_<source_id>_<target_id>_0",
    "type": "connection",
    "source_thread_id": "<source_id>",
    "target_thread_id": "<target_id>",
    "question": "...",
    "answer": "...",
    "difficulty": "intermediate",
    "concepts": ["concept1"]
  }}
]"""

        try:
            resp = client.models.generate_content(model=MODEL, contents=prompt)
            text = strip_fences(resp.text)
            edge_quizzes = json.loads(text)
            quizzes.extend(edge_quizzes)
        except Exception as e:
            print(f"  Edge quiz batch error: {e}")
        time.sleep(0.5)

    return quizzes


def main():
    if not RAW_PATH.exists():
        print(f"Raw data not found at {RAW_PATH}. Run scrape_blog.py first.")
        sys.exit(1)

    with open(RAW_PATH) as f:
        raw_posts = json.load(f)

    print(f"Loaded {len(raw_posts)} posts")

    # Pass 1: Enrich individual posts
    enriched = []
    for i, post in enumerate(raw_posts):
        print(f"[{i+1}/{len(raw_posts)}] Enriching: {post['title'][:60]}")
        try:
            meta = enrich_single_post(post)
            enriched.append({
                **post,
                "summary": meta.get("summary", ""),
                "concepts": meta.get("concepts", []),
                "difficulty": meta.get("difficulty", "intermediate"),
            })
        except Exception as e:
            print(f"  Error: {e}")
            enriched.append({
                **post,
                "summary": "",
                "concepts": [],
                "difficulty": "intermediate",
            })
        time.sleep(0.5)

    # Collect all unique concepts
    concept_map = {}
    for p in enriched:
        for c in p.get("concepts", []):
            c_lower = c.lower().strip()
            if c_lower not in concept_map:
                concept_map[c_lower] = {"name": c, "thread_ids": set()}
            concept_map[c_lower]["thread_ids"].add(p["id"])

    # Pass 2: Generate connections
    print("\nGenerating cross-post connections...")
    try:
        connections = generate_connections(enriched)
    except Exception as e:
        print(f"Error generating connections: {e}")
        connections = {"edges": [], "clusters": [], "learning_paths": []}

    # Pass 3: Generate quizzes
    print("\nGenerating quiz questions...")
    try:
        quizzes = generate_quizzes(enriched, connections.get("edges", []))
    except Exception as e:
        print(f"Error generating quizzes: {e}")
        quizzes = []
    print(f"  Generated {len(quizzes)} quiz questions")

    # Build final output
    concepts_list = [
        {"name": v["name"], "thread_ids": list(v["thread_ids"]), "description": ""}
        for v in concept_map.values()
        if len(v["thread_ids"]) >= 2
    ]

    cluster_lookup = {}
    for cluster in connections.get("clusters", []):
        for tid in cluster.get("thread_ids", []):
            cluster_lookup[tid] = cluster["name"]

    for p in enriched:
        p["cluster"] = cluster_lookup.get(p["id"], "General")

    output = {
        "threads": enriched,
        "concepts": sorted(concepts_list, key=lambda x: len(x["thread_ids"]), reverse=True),
        "edges": connections.get("edges", []),
        "learning_paths": connections.get("learning_paths", []),
        "clusters": connections.get("clusters", []),
        "quizzes": quizzes,
    }

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT, "w") as f:
        json.dump(output, f, indent=2)

    print(f"\nDone! Saved to {OUTPUT}")
    print(f"  {len(enriched)} posts")
    print(f"  {len(concepts_list)} shared concepts")
    print(f"  {len(output['edges'])} edges")
    print(f"  {len(output['clusters'])} clusters")
    print(f"  {len(output['learning_paths'])} learning paths")
    print(f"  {len(output['quizzes'])} quiz questions")


if __name__ == "__main__":
    main()
