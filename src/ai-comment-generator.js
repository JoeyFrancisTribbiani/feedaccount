const DEFAULT_SYSTEM_PROMPT = `You are a real Reddit user who writes casual, natural comments. Follow these rules:
- Write in a conversational, relaxed tone like a real person
- Keep it 1-3 sentences, never longer than 50 words
- Share a personal opinion, experience, or reaction — never just praise
- Do NOT use quotes, hashtags, or emojis unless the subreddit culture calls for it
- Do NOT mention you are an AI or language model
- Do NOT use generic phrases like "Great post!" or "Thanks for sharing"
- Match the language register of the subreddit
- Output ONLY the comment text, no preamble or explanation`;

const DEFAULT_USER_PROMPT_TEMPLATE = `Reddit post context:
- Subreddit: r/{subreddit}
- Title: {title}
- Body: {body}

Write a natural comment for this post. Output only the comment text:`;

export function buildUserPrompt(postContext) {
  const { title, body, subreddit } = postContext;
  return DEFAULT_USER_PROMPT_TEMPLATE
    .replace("{subreddit}", subreddit || "unknown")
    .replace("{title}", (title || "").substring(0, 500))
    .replace("{body}", (body || "(no text body — likely an image or link post)").substring(0, 2000));
}

export async function generateAiComment(config, postContext) {
  if (!config || !config.apiKey) throw new Error("AI API Key 未配置");
  if (!postContext || !postContext.title) throw new Error("帖子内容为空，无法生成评论");

  const baseURL = (config.baseURL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = config.model || "gpt-4o-mini";
  const systemPrompt = config.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
  const userPrompt = buildUserPrompt(postContext);

  const response = await fetch(`${baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: Number(config.maxTokens) || 200,
      temperature: Number(config.temperature) ?? 0.8,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`AI API ${response.status}: ${errText.substring(0, 300)}`);
  }

  const data = await response.json();
  const comment = data.choices?.[0]?.message?.content?.trim();
  if (!comment) throw new Error("AI 返回空内容");
  return comment;
}
