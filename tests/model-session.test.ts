import { beforeEach, expect, mock, test } from "bun:test"

import type { Model } from "../src/services/copilot/get-models"

import { state } from "../src/lib/state"
import {
  createChatCompletions,
  type ChatCompletionsPayload,
} from "../src/services/copilot/create-chat-completions"
import {
  ensureModelSession,
  modelSessionHeaders,
} from "../src/services/copilot/create-model-session"

state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

interface RecordedCall {
  url: string
  headers: Record<string, string>
  body?: string
}

const calls: Array<RecordedCall> = []

const fetchMock = mock((url: string, opts: RecordedCall) => {
  calls.push({ url, headers: opts.headers, body: opts.body })
  if (url.endsWith("/models/session")) {
    return {
      ok: true,
      json: () =>
        Promise.resolve({
          available_models: ["claude-haiku-4.5", "gpt-5-mini"],
          selected_model: "claude-haiku-4.5",
          session_token: "sess-token-123",
        }),
    }
  }
  return {
    ok: true,
    json: () =>
      Promise.resolve({ id: "123", object: "chat.completion", choices: [] }),
  }
})
// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

beforeEach(() => {
  calls.length = 0
  fetchMock.mockClear()
  state.modelSession = undefined
  state.models = undefined
})

test("creates a session and caches it", async () => {
  const first = await ensureModelSession()
  const second = await ensureModelSession()
  expect(first?.token).toBe("sess-token-123")
  expect(second?.token).toBe("sess-token-123")
  expect(calls.filter((c) => c.url.endsWith("/models/session"))).toHaveLength(1)
})

test("attaches the session header only for pooled models", async () => {
  const pooled = await modelSessionHeaders("claude-haiku-4.5")
  expect(pooled["Copilot-Session-Token"]).toBe("sess-token-123")

  const unpooled = await modelSessionHeaders("gpt-4.1")
  expect(unpooled).toEqual({})
})

test("refreshes an expired session", async () => {
  await ensureModelSession()
  const session = state.modelSession
  if (!session) throw new Error("expected a cached session")
  session.expiresAt = Date.now() - 1

  const refreshed = await ensureModelSession()
  expect(refreshed?.token).toBe("sess-token-123")
  expect(calls.filter((c) => c.url.endsWith("/models/session"))).toHaveLength(2)
})

const makeModel = (id: string): Model => ({
  id,
  name: id,
  object: "model",
  version: "1",
  vendor: "test",
  preview: false,
  model_picker_enabled: true,
})

test("hints every known model to maximize the session pool", async () => {
  state.models = {
    object: "list",
    data: [makeModel("gpt-4.1"), makeModel("claude-haiku-4.5")],
  }

  await ensureModelSession()

  const sessionCall = calls.find((c) => c.url.endsWith("/models/session"))
  const body = JSON.parse(sessionCall?.body ?? "{}") as {
    auto_mode?: { model_hints?: Array<string> }
  }
  expect(body.auto_mode?.model_hints).toEqual(["gpt-4.1", "claude-haiku-4.5"])
})

test("createChatCompletions sends the session token for pooled models", async () => {
  const payload: ChatCompletionsPayload = {
    model: "claude-haiku-4.5",
    messages: [{ role: "user", content: "hi" }],
  }
  await createChatCompletions(payload)
  const chat = calls.find((c) => c.url.endsWith("/chat/completions"))
  expect(chat?.headers["Copilot-Session-Token"]).toBe("sess-token-123")
})
