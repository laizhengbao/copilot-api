import consola from "consola"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { state } from "~/lib/state"

export interface ModelSession {
  token: string
  availableModels: Array<string>
  expiresAt: number
}

interface ModelSessionResponse {
  available_models?: Array<string>
  selected_model: string
  session_token: string
}

// Upstream session tokens live ~1h; refresh a bit early to be safe
const SESSION_TTL_MS = 55 * 60 * 1000

// When session creation fails (e.g. the account/SKU does not support it),
// back off for a while instead of retrying on every single request
const FAILURE_BACKOFF_MS = 5 * 60 * 1000

let retryAfter = 0
let pending: Promise<ModelSession | undefined> | undefined

// The session's available_models pool is the intersection of the requested
// hints and what the account is entitled to. Hinting every known model
// maximizes the pool (the plain "auto" rotation is only a subset), unlocking
// e.g. the mai-code-1-flash-* variants that auto mode never includes.
const modelHints = (): Array<string> => {
  const hints = state.models?.data.map((entry) => entry.id) ?? []
  return hints.length > 0 ? hints : ["auto"]
}

/**
 * GitHub serves some models (e.g. Claude on limited SKUs) only through the
 * auto-mode model session flow: POST /models/session returns a short-lived
 * session token that must be attached as `Copilot-Session-Token` on chat,
 * responses and messages calls for the models it lists as available.
 *
 * Best-effort: when session creation fails, requests are still sent without
 * the header so base models keep working. Concurrent callers share one
 * in-flight request; failures are cached for FAILURE_BACKOFF_MS.
 */
export const ensureModelSession = async (): Promise<
  ModelSession | undefined
> => {
  if (!state.copilotToken) return

  const current = state.modelSession
  if (current && current.expiresAt > Date.now()) return current
  if (Date.now() < retryAfter) return undefined

  pending ??= createSession().finally(() => {
    pending = undefined
  })
  return pending
}

const createSession = async (): Promise<ModelSession | undefined> => {
  try {
    const response = await fetch(`${copilotBaseUrl(state)}/models/session`, {
      method: "POST",
      headers: copilotHeaders(state),
      body: JSON.stringify({ auto_mode: { model_hints: modelHints() } }),
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      consola.warn("Model session creation failed with status", response.status)
      retryAfter = Date.now() + FAILURE_BACKOFF_MS
      return undefined
    }

    const data = (await response.json()) as ModelSessionResponse
    const session: ModelSession = {
      token: data.session_token,
      availableModels: data.available_models ?? [],
      expiresAt: Date.now() + SESSION_TTL_MS,
    }
    // eslint-disable-next-line require-atomic-updates
    state.modelSession = session
    consola.info(
      "Model session created, unlocked models:",
      session.availableModels.join(", ") || "(none)",
    )
    return session
  } catch (error) {
    consola.warn("Model session creation errored:", error)
    retryAfter = Date.now() + FAILURE_BACKOFF_MS
    return undefined
  }
}

/**
 * Returns the `Copilot-Session-Token` header when the given model requires
 * the auto-mode session flow, otherwise an empty header map.
 */
export const modelSessionHeaders = async (
  model: string,
): Promise<Record<string, string>> => {
  const session = await ensureModelSession()
  if (!session?.availableModels.includes(model)) return {}
  return { "Copilot-Session-Token": session.token }
}
