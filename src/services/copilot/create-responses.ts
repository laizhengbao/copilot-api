import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { modelSessionHeaders } from "~/services/copilot/create-model-session"

// Responses API payloads are forwarded as-is (model, input, instructions,
// tools, stream, ...). The raw upstream Response is returned so streaming
// (SSE) bodies can be piped through untouched.
export interface ResponsesPayload {
  model: string
  [key: string]: unknown
}

export const createResponses = async (payload: ResponsesPayload) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const sessionHeaders = await modelSessionHeaders(payload.model)

  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers: {
      ...copilotHeaders(state),
      ...sessionHeaders,
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) throw new HTTPError("Failed to create responses", response)

  return response
}
