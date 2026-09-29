import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

import { forwardError } from "~/lib/error"
import { createChatCompletions } from "~/services/copilot/create-chat-completions"
import {
  createResponses,
  type ResponsesPayload,
} from "~/services/copilot/create-responses"
import {
  chatResultToResponsesResult,
  isResponsesCapableModel,
  responsesPayloadToChatPayload,
  streamChatAsResponsesEvents,
} from "~/services/copilot/responses-adapter"

export const responseRoutes = new Hono()

responseRoutes.post("/", async (c) => {
  try {
    const payload = await c.req.json<Record<string, unknown>>()
    const model = typeof payload.model === "string" ? payload.model : ""

    // responses-native models stream straight through
    if (isResponsesCapableModel(model)) {
      const response = await createResponses(payload as ResponsesPayload)
      const body = response.body
      if (!body) {
        return c.json({ error: "Empty response body" }, 502)
      }

      const contentType =
        response.headers.get("content-type") ?? "application/json"

      return c.body(body, 200, {
        "content-type": contentType,
        "cache-control": "no-cache",
      })
    }

    // chat-only models are served by translating through Chat Completions
    const chatPayload = responsesPayloadToChatPayload(payload)

    if (payload.stream === true) {
      const chatStream = (await createChatCompletions({
        ...chatPayload,
        stream: true,
      })) as AsyncIterable<{ data?: string | null }>

      return streamSSE(c, async (stream) => {
        for await (const event of streamChatAsResponsesEvents(
          chatStream,
          model,
        )) {
          await stream.writeSSE({ data: event.data })
        }
      })
    }

    const chatResult = await createChatCompletions(chatPayload)
    const responsesResult = chatResultToResponsesResult(
      chatResult as Parameters<typeof chatResultToResponsesResult>[0],
    )
    return c.json(responsesResult)
  } catch (error) {
    return await forwardError(c, error)
  }
})
