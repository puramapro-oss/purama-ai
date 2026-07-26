/**
 * Appelle l'API Anthropic en streaming et retourne un ReadableStream au format SSE
 * compatible OpenAI (`data: {"choices":[{"delta":{"content":"..."}}]}`) — pour que les
 * clients frontend existants (ChatbotWidget, etc.) n'aient rien à changer.
 *
 * Remplace l'appel au gateway Lovable (ai.gateway.lovable.dev) qui utilisait une clé
 * LOVABLE_API_KEY jamais configurée sur ce VPS (cf AUDIT-AGENTS.md) — ANTHROPIC_API_KEY
 * est déjà présente dans l'environnement du container supabase-edge-functions.
 */
export async function streamAnthropicChat(params: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens?: number;
}): Promise<Response> {
  const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": params.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: params.model,
      max_tokens: params.maxTokens ?? 1024,
      system: params.systemPrompt,
      messages: params.messages,
      stream: true,
    }),
  });

  if (!anthropicResponse.ok || !anthropicResponse.body) {
    return anthropicResponse;
  }

  const openAiCompatibleStream = new ReadableStream({
    async start(controller) {
      const reader = anthropicResponse.body!.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6);

            try {
              const event = JSON.parse(payload) as {
                type: string;
                delta?: { type: string; text?: string };
              };

              if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
                const chunk = { choices: [{ delta: { content: event.delta.text } }] };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              }
            } catch {
              // ligne SSE incomplète ou event Anthropic sans texte (message_start, ping...) — ignoré
            }
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(openAiCompatibleStream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}
