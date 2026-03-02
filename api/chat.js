import Anthropic from "@anthropic-ai/sdk";

export const maxDuration = 30;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
  }

  const { question, context, datasetTitle } = req.body;
  if (!question) {
    return res.status(400).json({ error: "question is required" });
  }

  const client = new Anthropic({ apiKey: key });

  try {
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `You are a helpful assistant that answers questions based on the ${datasetTitle || "Moontower"} content.

Here are the most relevant items:
${context || "No context available."}

Question: ${question}

Answer concisely, citing specific items when relevant.`,
        },
      ],
    });

    const answer = msg.content[0].text;
    return res.status(200).json({ answer });
  } catch (e) {
    console.error("Chat error:", e);
    return res.status(500).json({ error: e.message });
  }
}
