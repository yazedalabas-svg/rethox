import "./env.js";
export interface SummaryProvider {
  summarize(text: string): Promise<string>;
}

export class OpenRouterSummaryProvider implements SummaryProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini",
  ) {}

  async summarize(text: string) {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        "HTTP-Referer": process.env.PUBLIC_SITE_URL || "http://127.0.0.1:5173",
        "X-Title": "rethox",
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        max_tokens: 120,
        messages: [
          {
            role: "system",
            content:
              "أنت محرر عربي. لخّص النص في جملة عربية واحدة واضحة دون إضافة معلومات جديدة.",
          },
          { role: "user", content: text },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(`OpenRouter request failed: ${response.status}`);
    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("OpenRouter returned an empty summary");
    return content;
  }
}

export const summaryProvider = process.env.OPENROUTER_API_KEY?.trim()
  ? new OpenRouterSummaryProvider(process.env.OPENROUTER_API_KEY.trim())
  : null;

export interface IllustrationAltProvider {
  describe(image: Buffer, mime: string): Promise<string>;
}

export class OpenRouterIllustrationAltProvider implements IllustrationAltProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model = process.env.OPENROUTER_VISION_MODEL || "openai/gpt-4o-mini",
  ) {}

  async describe(image: Buffer, mime: string) {
    const dataUrl = `data:${mime};base64,${image.toString("base64")}`;
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        "HTTP-Referer": process.env.PUBLIC_SITE_URL || "http://127.0.0.1:5173",
        "X-Title": "rethox",
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        max_tokens: 60,
        messages: [
          {
            role: "system",
            content:
              "أنت محرر عربي يكتب نص alt موجز لصورة توضيحية داخل رواية. صف محتوى الصورة فعليًا في جملة عربية واحدة قصيرة، دون مقدمات ودون تخمين أحداث القصة.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "اكتب alt text لهذه الصورة." },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      throw new Error(`OpenRouter vision request failed: ${response.status}`);
    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("OpenRouter returned an empty alt text");
    return content;
  }
}

export const illustrationAltProvider = process.env.OPENROUTER_API_KEY?.trim()
  ? new OpenRouterIllustrationAltProvider(process.env.OPENROUTER_API_KEY.trim())
  : null;
