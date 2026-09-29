import { beforeEach, expect, mock, test } from "bun:test"
import { events } from "fetch-event-stream"

import type { Model } from "../src/services/copilot/get-models"

import { state } from "../src/lib/state"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "../src/services/copilot/create-chat-completions"
import {
  chatPayloadToResponsesPayload,
  isResponsesOnlyModel,
  responsesResultToChatCompletion,
  streamResponsesAsChatChunks,
} from "../src/services/copilot/responses-adapter"

const responsesOnly: Model = {
  id: "gpt-5.3-codex",
  name: "GPT-5.3 Codex",
  object: "model",
  version: "1",
  vendor: "openai",
  preview: false,
  model_picker_enabled: true,
  supported_endpoints: ["/responses"],
}

const chatCapable: Model = {
  ...responsesOnly,
  id: "gpt-4o",
  supported_endpoints: ["/chat/completions", "/responses"],
}

state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

beforeEach(() => {
  state.models = { object: "list", data: [responsesOnly, chatCapable] }
  state.modelSession = {
    token: "test-session",
    availableModels: [],
    expiresAt: Date.now() + 60_000,
  }
})

test("isResponsesOnlyModel only flags responses-only models", () => {
  expect(isResponsesOnlyModel("gpt-5.3-codex")).toBe(true)
  expect(isResponsesOnlyModel("gpt-4o")).toBe(false)
  expect(isResponsesOnlyModel("unknown-model")).toBe(false)
})

test("chatPayloadToResponsesPayload converts instructions, tools and limits", () => {
  const result = chatPayloadToResponsesPayload({
    model: "gpt-5.3-codex",
    messages: [
      { role: "system", content: "Be terse" },
      { role: "user", content: "say hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "greet", arguments: "{}" },
          },
        ],
      },
      { role: "tool", content: "hello", tool_call_id: "call_1" },
    ],
    max_tokens: 42,
    tools: [
      {
        type: "function",
        function: { name: "greet", description: "d", parameters: {} },
      },
    ],
  })

  expect(result.instructions).toBe("Be terse")
  expect(result.max_output_tokens).toBe(42)
  expect(result.model).toBe("gpt-5.3-codex")

  const input = result.input as Array<Record<string, unknown>>
  expect(input[0]).toEqual({ role: "user", content: "say hi" })
  expect(input[1]).toEqual({
    type: "function_call",
    call_id: "call_1",
    name: "greet",
    arguments: "{}",
  })
  expect(input[2]).toEqual({
    type: "function_call_output",
    call_id: "call_1",
    output: "hello",
  })

  expect(result.tools).toEqual([
    { type: "function", name: "greet", description: "d", parameters: {} },
  ])
})

test("responsesResultToChatCompletion rebuilds text, tool calls and usage", () => {
  const result = responsesResultToChatCompletion(
    {
      id: "resp_1",
      created_at: 123,
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "hello world" }],
        },
        {
          type: "function_call",
          call_id: "call_9",
          name: "greet",
          arguments: "{}",
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
    "gpt-5.3-codex",
  )

  expect(result.object).toBe("chat.completion")
  expect(result.choices[0].message.content).toBe("hello world")
  expect(result.choices[0].message.tool_calls?.[0]?.function.name).toBe("greet")
  expect(result.choices[0].finish_reason).toBe("tool_calls")
  expect(result.usage?.prompt_tokens).toBe(10)
  expect(result.usage?.total_tokens).toBe(15)
})

const sseBody = (lines: Array<object>) =>
  lines.map((line) => `data: ${JSON.stringify(line)}\n\n`).join("")

test("streamResponsesAsChatChunks emits role, text and finish chunks", async () => {
  const body = sseBody([
    { type: "response.created", response: { id: "resp_9", created_at: 42 } },
    { type: "response.output_text.delta", delta: "PO" },
    { type: "response.output_text.delta", delta: "NG" },
    {
      type: "response.completed",
      response: {
        id: "resp_9",
        created_at: 42,
        output: [
          { type: "message", content: [{ type: "output_text", text: "PONG" }] },
        ],
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      },
    },
  ])
  const upstream = new Response(body, {
    headers: { "content-type": "text/event-stream" },
  })

  const chunks: Array<ChatCompletionChunk> = []
  for await (const event of streamResponsesAsChatChunks(
    upstream,
    "gpt-5.3-codex",
    events,
  )) {
    chunks.push(JSON.parse(event.data) as ChatCompletionChunk)
  }

  expect(chunks[0].choices[0].delta.role).toBe("assistant")
  const text = chunks.map((c) => c.choices[0].delta.content ?? "").join("")
  expect(text).toBe("PONG")
  const last = chunks.at(-1)
  if (!last) throw new Error("expected to finish with a final chunk")
  expect(last.choices[0].finish_reason).toBe("stop")
  expect(last.usage?.total_tokens).toBe(6)
})

test("createChatCompletions translates responses-only models end to end", async () => {
  const upstream = new Response(
    JSON.stringify({
      id: "resp_5",
      created_at: 100,
      output: [
        { type: "message", content: [{ type: "output_text", text: "PONG" }] },
      ],
      usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
  const fetchMock = mock((_url: string, _opts?: unknown) => upstream)
  // @ts-expect-error - Mock fetch doesn't implement all fetch properties
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

  const result = (await createChatCompletions({
    model: "gpt-5.3-codex",
    messages: [{ role: "user", content: "hi" }],
  })) as ChatCompletionResponse

  expect(result.choices[0].message.content).toBe("PONG")
  expect(result.choices[0].finish_reason).toBe("stop")
  expect(result.usage?.prompt_tokens).toBe(3)
})
