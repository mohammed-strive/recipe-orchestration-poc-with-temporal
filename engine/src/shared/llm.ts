// Direct Messages API calls for short, tool-free judgements (reranking, card drafting).
// No agent session is needed for these, so they are cheaper and faster than a session.
import Anthropic from "@anthropic-ai/sdk";
import { extractJsonObject } from "./util.js";

let client: Anthropic | null = null;

export async function askJson(prompt: string, model: string, maxTokens = 2000): Promise<{ json: unknown; usage: unknown }> {
  client ??= new Anthropic(); // reads ANTHROPIC_API_KEY
  const msg = await client.messages.create({ model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] });
  const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return { json: extractJsonObject(text), usage: msg.usage };
}
