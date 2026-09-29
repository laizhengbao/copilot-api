import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

import { forwardError } from "~/lib/error"
import {
  chatResultToCompletionResult,
  completionPayloadToChatPayload,
  streamChatAsCompletionChunks,
} from "~/services/copilot/completions-adapter"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"
import {
  aggregateProxyCompletionsStream,
  createProxyCompletions,
  type CompletionsPayload,
} from "~/services/copilot/create-proxy-completions"

export const completionsRoutes = new Hono()

completionsRoutes.post("/", async (c) => {
  try {
    const payload = await c.req.json<CompletionsPayload>()

    // legacy fill-in-the-middle engines (gpt-41-copilot, ...) live behind
    // the traditional proxy completions API; everything else is translated
    // through Chat Completions so all models are reachable here
    if (payload.model.endsWith("-copilot")) {
      if (payload.stream) {
        const response = await createProxyCompletions(payload)
        const body = response.body
        if (!body) {
          return c.json({ error: "Empty response body" }, 502)
        }
        return c.body(body, 200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        })
      }

      const result = await aggregateProxyCompletionsStream(payload)
      return c.json(result)
    }

    const chatPayload = completionPayloadToChatPayload(payload)

    if (payload.stream) {
      const chatStream = (await createChatCompletions({
        ...chatPayload,
        stream: true,
      })) as AsyncIterable<{ data?: string | null }>

      return streamSSE(c, async (stream) => {
        for await (const event of streamChatAsCompletionChunks(chatStream)) {
          await stream.writeSSE({ data: event.data })
        }
      })
    }

    const chatResult = await createChatCompletions(chatPayload)
    const result = chatResultToCompletionResult(
      chatResult as Parameters<typeof chatResultToCompletionResult>[0],
    )
    return c.json(result)
  } catch (error) {
    return await forwardError(c, error)
  }
})
