import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"

const DEFAULT_PROXY_BASE_URL = "https://copilot-proxy.githubusercontent.com"

/**
 * Legacy "-copilot" engine models (e.g. `gpt-41-copilot` used for inline
 * fill-in-the-middle suggestions) are not served by the CAPI chat endpoints;
 * they live behind the traditional Copilot proxy completions API:
 *
 *   POST {proxyBase}/v1/engines/{model}/completions   (stream ONLY)
 *
 * The proxy rejects non-streaming requests, so `stream: true` is always
 * forced upstream and aggregated for clients that ask for a full response.
 */
export const createProxyCompletions = async (payload: CompletionsPayload) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const base = await ensureProxyBaseUrl()
  const response = await fetch(
    `${base}/v1/engines/${payload.model}/completions`,
    {
      method: "POST",
      headers: copilotHeaders(state),
      body: JSON.stringify({ ...payload, stream: true }),
    },
  )

  if (!response.ok) {
    throw new HTTPError("Failed to create completions", response)
  }

  return response
}

/** Aggregates the streaming upstream response into one legacy completion. */
export const aggregateProxyCompletionsStream = async (
  payload: CompletionsPayload,
): Promise<ProxyCompletionResult> => {
  const response = await createProxyCompletions(payload)

  let id = ""
  let text = ""
  let finishReason: string | null = null

  for await (const event of events(response)) {
    if (!event.data) continue
    if (event.data === "[DONE]") break
    const chunk = JSON.parse(event.data) as LegacyCompletionChunk
    if (chunk.id) id = chunk.id
    for (const choice of chunk.choices ?? []) {
      if (typeof choice.text === "string") text += choice.text
      if (choice.finish_reason) finishReason = choice.finish_reason
    }
  }

  return {
    id,
    object: "text_completion",
    created: Math.floor(Date.now() / 1000),
    model: payload.model,
    choices: [
      { text, index: 0, finish_reason: finishReason ?? "stop", logprobs: null },
    ],
  }
}

const ensureProxyBaseUrl = async (): Promise<string> => {
  if (state.proxyBaseUrl) return state.proxyBaseUrl

  try {
    const usage = await getCopilotUsage()
    const proxy = usage.endpoints?.proxy
    if (proxy) {
      // eslint-disable-next-line require-atomic-updates
      state.proxyBaseUrl = proxy
      return proxy
    }
  } catch (error) {
    consola.warn("Failed to resolve proxy base URL, using default:", error)
  }

  // eslint-disable-next-line require-atomic-updates
  state.proxyBaseUrl = DEFAULT_PROXY_BASE_URL
  return DEFAULT_PROXY_BASE_URL
}

export interface CompletionsPayload {
  model: string
  prompt: string | Array<string>
  max_tokens?: number | null
  temperature?: number | null
  top_p?: number | null
  n?: number | null
  stream?: boolean | null
  stop?: string | Array<string> | null
  suffix?: string | null
  [key: string]: unknown
}

interface LegacyCompletionChunk {
  id?: string
  model?: string
  choices?: Array<{
    text?: string
    index: number
    finish_reason: string | null
  }>
}

export interface ProxyCompletionResult {
  id: string
  object: "text_completion"
  created: number
  model: string
  choices: Array<{
    text: string
    index: number
    finish_reason: string
    logprobs: null
  }>
}
