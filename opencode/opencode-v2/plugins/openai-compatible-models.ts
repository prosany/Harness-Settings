type ModelEntry = {
  id?: unknown
  owned_by?: unknown
}

type Provider = {
  id: string
  package: string
  settings?: Record<string, unknown>
  headers?: Record<string, string>
}

type ModelDraft = {
  provider: {
    list(): ReadonlyArray<{ provider: Provider }>
  }
  get(providerID: string, modelID: string): unknown
  update(
    providerID: string,
    modelID: string,
    callback: (model: { name: string }) => void,
  ): void
}

type PluginContext = {
  model: {
    reload(): Promise<void>
    transform(callback: (draft: ModelDraft) => void): Promise<unknown>
  }
}

type Discovery = {
  fingerprint: string
  models?: Set<string>
}

async function discover(provider: Provider, signal: AbortSignal) {
  const baseURL = provider.settings?.baseURL
  if (typeof baseURL !== "string") return new Set<string>()

  const apiKey = provider.settings?.apiKey
  const modelsURL = new URL("models", `${baseURL.replace(/\/+$/, "")}/`)
  const response = await fetch(modelsURL, {
    headers: {
      ...provider.headers,
      ...(typeof apiKey === "string"
        ? { Authorization: `Bearer ${apiKey}` }
        : {}),
    },
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  })

  if (!response.ok) {
    throw new Error(
      `Model discovery failed for ${provider.id}: ${response.status} ${response.statusText}`,
    )
  }

  const payload = (await response.json()) as { data?: unknown } | null
  if (!Array.isArray(payload?.data)) {
    throw new Error(`Model discovery returned an invalid list for ${provider.id}`)
  }

  const entries = payload.data.filter(
    (entry): entry is ModelEntry & { id: string } =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as ModelEntry).id === "string" &&
      (entry as { id: string }).id.length > 0,
  )
  const models = new Set<string>()

  for (const entry of entries.sort((a, b) => a.id.localeCompare(b.id))) {
    const hasPrefixedAlias = entries.some((candidate) => {
      return (
        candidate.owned_by === entry.owned_by &&
        candidate.id.endsWith(`/${entry.id}`) &&
        candidate.id !== entry.id
      )
    })
    if (!entry.id.includes("/") && hasPrefixedAlias) continue
    models.add(entry.id)
  }

  if (models.size === 0) {
    throw new Error(`Model discovery returned no usable models for ${provider.id}`)
  }
  return models
}

export default {
  id: "openai-compatible-models",
  async setup(ctx: PluginContext) {
    const controller = new AbortController()
    const discovered = new Map<string, Discovery>()

    await ctx.model.transform((draft) => {
      if (controller.signal.aborted) return

      for (const { provider } of draft.provider.list()) {
        if (provider.package !== "@opencode/ai/providers/openai-compatible") continue
        if (provider.id === "opencode" || provider.id === "opencode-go") continue
        if (typeof provider.settings?.baseURL !== "string") continue

        const fingerprint = JSON.stringify([
          provider.package,
          provider.settings,
          provider.headers,
        ])
        let discovery = discovered.get(provider.id)

        if (discovery?.fingerprint !== fingerprint) {
          discovery = { fingerprint }
          discovered.set(provider.id, discovery)
          const current = discovery
          const snapshot = structuredClone(provider)

          // Transform callbacks are synchronous; fetch only after the draft closes.
          void Promise.resolve()
            .then(() => discover(snapshot, controller.signal))
            .then(async (models) => {
              if (controller.signal.aborted) return
              if (discovered.get(provider.id) !== current) return
              current.models = models
              await ctx.model.reload()
            })
            .catch((error) => {
              if (!controller.signal.aborted) {
                console.error("[openai-compatible-models]", error)
              }
            })
        }

        for (const modelID of discovery.models ?? []) {
          if (draft.get(provider.id, modelID)) continue
          draft.update(provider.id, modelID, (model) => {
            model.name = modelID
          })
        }
      }
    })

    return () => controller.abort()
  },
}
