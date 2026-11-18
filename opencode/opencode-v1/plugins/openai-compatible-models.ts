import type { Plugin } from "@opencode-ai/plugin"

type ModelEntry = {
  id?: unknown
  owned_by?: unknown
}

type ModelList = {
  data?: unknown
}

const plugin: Plugin = async () => ({
  config: async (config) => {
    for (const [providerID, provider] of Object.entries(config.provider ?? {})) {
      const baseURL = provider.options?.baseURL
      const apiKey = provider.options?.apiKey

      if (typeof baseURL !== "string") continue

      const modelsURL = new URL("models", `${baseURL.replace(/\/+$/, "")}/`)
      const response = await fetch(modelsURL, {
        headers:
          typeof apiKey === "string"
            ? { Authorization: `Bearer ${apiKey}` }
            : undefined,
        signal: AbortSignal.timeout(10_000),
      })

      if (!response.ok) {
        throw new Error(
          `Model discovery failed for ${providerID}: ${response.status} ${response.statusText}`,
        )
      }

      const payload = (await response.json()) as ModelList
      if (!Array.isArray(payload.data)) {
        throw new Error(
          `Model discovery returned an invalid list for ${providerID}`,
        )
      }

      const entries = payload.data.filter(
        (entry): entry is ModelEntry & { id: string } =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as ModelEntry).id === "string",
      )
      const models: NonNullable<typeof provider.models> = {}

      for (const entry of entries.sort((a, b) => a.id.localeCompare(b.id))) {
        const hasPrefixedAlias = entries.some((candidate) => {
          return (
            candidate.owned_by === entry.owned_by &&
            candidate.id.endsWith(`/${entry.id}`) &&
            candidate.id !== entry.id
          )
        })
        if (!entry.id.includes("/") && hasPrefixedAlias) continue
        models[entry.id] = { name: entry.id }
      }

      if (Object.keys(models).length === 0) {
        throw new Error(
          `Model discovery returned no usable models for ${providerID}`,
        )
      }

      provider.models = { ...models, ...provider.models }
    }
  },
})

export default plugin
