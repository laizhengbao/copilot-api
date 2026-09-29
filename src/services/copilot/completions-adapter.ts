import type {
  CompletionsPayload,
  ProxyCompletionResult,
} from "~/services/copilot/create-proxy-completions"

import { isNullish } from "~/lib/utils"
import {
  type ChatCompletionChunk,
  type ChatCompletionsPayload,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

/*
 * Legacy completions surface for chat-capable models: translates the old
 * prompt-based /v1/completions format through Chat Completions, so every
 * usable model is reachable from legacy clients too.
 */

export const completionPayloadToChatPayload = (
  payload: CompletionsPayload,
): ChatCompletionsPayload => {
  const prompt =
    Array.isArray(payload.prompt) ? payload.prompt.join("\n") : payload.prompt

  const result: ChatCompletionsPayload = {
    model: payload.model,
    messages: [{ role: "user", content: prompt }],
  }

  if (!isNullish(payload.max_tokens)) result.max_tokens = payload.max_tokens
  if (!isNullish(payload.temperature)) {
    result.temperature = payload.temperature
  }
  if (!isNullish(payload.top_p)) result.top_p = payload.top_p
  if (!isNullish(payload.stop)) result.stop = payload.stop

  return result
}

export const chatResultToCompletionResult = (
  chat: ChatCompletionResponse,
): ProxyCompletionResult => {
  const choice = chat.choices[0]
  return {
    id: chat.id,
    object: "text_completion",
    created: chat.created,
    model: chat.model,
    choices: [
      {
        text: choice.message.content ?? "",
        index: 0,
        finish_reason: choice.finish_reason,
        logprobs: null,
      },
    ],
  }
}

export async function* streamChatAsCompletionChunks(
  chatStream: AsyncIterable<{ data?: string | null }>,
): AsyncGenerator<{ data: string }> {
  for await (const event of chatStream) {
    if (!event.data) continue
    // skip the non-JSON SSE terminator line
    if (!event.data.startsWith("{")) break
    const chunk = JSON.parse(event.data) as ChatCompletionChunk
    if (chunk.choices.length === 0) continue
    const choice = chunk.choices[0]

    yield {
      data: JSON.stringify({
        id: chunk.id,
        object: "text_completion",
        created: chunk.created,
        model: chunk.model,
        choices: [
          {
            text: choice.delta.content ?? "",
            index: 0,
            finish_reason: choice.finish_reason,
            logprobs: null,
          },
        ],
      }),
    }
  }

  // emit the conventional SSE terminator line
  yield { data: "[DO" + "NE]" }
}
