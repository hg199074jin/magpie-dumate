// Import DuMate's real model catalog (metadata only) and keep an independent
// snapshot under magpie's own config directory.
//
// RanceLee (公众号 HelloRanceLee, 2026-11-13) pointed out that 0.2.1 shipped
// only two hardcoded fallback models with no real context metadata. His fix
// reads the active account's opencode.json, strips everything that is not
// model metadata, and persists a sanitized snapshot so uninstalling DuMate
// cannot wipe the model list. See README.md -> 致谢.
import { readFileSync, statSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { randomUUID } from "node:crypto"
import { discoverConfig } from "./paths.mjs"

// Keep this distinct from any community fork's directory: both plugins may be
// installed side by side and must not overwrite each other's snapshot.
export const SNAPSHOT_DIR_NAME = "magpie-dumate"

// v0.5.2：目录声明的 context 以实测为准的下调表（键 = 模型 id，小写）。
//
// 事故证据（2026-11-18，本机 magpie usage.jsonl）：`deepseek-v41-flash` 在输入
// 52.3 万 tokens 时正常（stop=tool_calls），57.5 万起连续 4 次返回 out=47 tokens、
// stop=content_filter（上游把回答替换成固定话术）。注册表宣称的 1000k 与实测
// 安全区不符——**不是**上游硬上限，只是注册表值。下调到 512k 让宿主（ZCode/Codex）
// 在安全区内先压缩上下文，避免请求撞上内容过滤。阈值机制 UNKNOWN，取 512k 留余量。
export const SAFE_CONTEXT_CAPS = {
  "deepseek-v41-flash": 512_000,
}

const validId = (id) => typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}$/.test(id)
const positive = (n) => Number.isSafeInteger(n) && n > 0
const modalities = (list) => Array.isArray(list)
  ? [...new Set(list.filter((x) => ["text", "image", "audio", "video", "pdf"].includes(x)))]
  : ["text"]

// Only models whose reasoning controls are demonstrated on the real gateway
// advertise levels (2026-11-17 live probes; README「推理档位」has the table).
// Today that is deepseek-v41-flash alone: glm-53's reasoning_effort actually
// disables thinking, the auto routers and kimi fluctuate inside noise, and
// deepseek-v4-pro ran at or below its low level. Everything else stays silent —
// a model that cannot honour levels must not offer them.
//
// The whitelist lives in reasoning.mjs (single source, CR-001); this module
// only reads it, so a model can never advertise levels the request path would
// not honour.
import { REASONING } from "./reasoning.mjs"

function readJson(path) {
  const st = statSync(path)
  if (!st.isFile() || st.size <= 0 || st.size > 2 * 1024 * 1024) throw new Error("Invalid model catalog size")
  return JSON.parse(readFileSync(path, "utf8"))
}

// Only model metadata crosses this boundary. Endpoints, apiKey, headers,
// plugins, commands and permissions from the source config are never copied.
export function importModels(config) {
  const source = config?.provider?.QianfanPersonalQuota?.models
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Missing DuMate model catalog")
  const models = Object.create(null)
  let excluded = 0
  for (const [key, value] of Object.entries(source)) {
    const id = value?.id ?? key
    if (!validId(key) || !validId(id) || !value || typeof value !== "object") continue
    // Internal task routers, mocks, OCR, embeddings, rerankers and the
    // dedicated image generator are not chat entries.
    if ((key.startsWith("model-") && key !== "model-text") ||
        /(?:embedding|reranker|ocr|^llm-mock$|^dumate-image)/i.test(key)) {
      excluded++
      continue
    }
    // A display alias pointing at a real entry of its own is a duplicate.
    if (key !== id && Object.hasOwn(source, id)) {
      excluded++
      continue
    }
    let context = value.limit?.context ?? value.limit?.input
    const output = value.limit?.output
    if (!positive(context) || !positive(output)) continue
    // v0.5.2：实测安全上限优先于注册表宣称值（见 SAFE_CONTEXT_CAPS 的注释）。
    const safeCap = SAFE_CONTEXT_CAPS[String(key).toLowerCase()] ?? SAFE_CONTEXT_CAPS[String(id).toLowerCase()]
    if (positive(safeCap)) context = Math.min(context, safeCap)
    const input = modalities(value.modalities?.input)
    if (!input.includes("text")) continue
    const variants = REASONING[id]
    models[key] = {
      id,
      // e.g. the old "glm-5" key actually calls "model-text".
      name: key === id ? key : `${key} (API: ${id})`,
      limit: { context, output },
      tool_call: value.tool_call !== false,
      // The registry's own thinking/capabilities fields are untrusted: the
      // cloud pushes thinking:{mode:"never"} for every entry, including models
      // that think by default. The whitelist is the authoritative source.
      reasoning: !!variants || value.reasoning === true || value.capabilities?.reasoning === true,
      ...(variants ? { variants } : {}),
      attachment: input.some((x) => x !== "text"),
      modalities: { input, output: ["text"] },
    }
  }
  if (!Object.keys(models).length) throw new Error("No chat models in DuMate catalog")
  return { schema: 1, models, excluded }
}

// Snapshots are re-validated through the same filter, so a tampered or stale
// snapshot cannot smuggle an endpoint or a key into the provider config.
function fromSnapshot(snapshot) {
  if (snapshot?.schema !== 1) throw new Error("Unsupported catalog schema")
  return importModels({ provider: { QianfanPersonalQuota: { models: snapshot.models } } }).models
}

function saveSnapshot(path, catalog) {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(catalog, null, 2) + "\n", { mode: 0o600, flag: "wx" })
    renameSync(temp, path)
  } finally {
    try { unlinkSync(temp) } catch {
      // rename succeeded (or the temp file never existed) - nothing to clean.
    }
  }
}

// stateDir is magpie's plugin directory passed to the plugin factory. If the
// host does not supply it, fall back to magpie's standard config location.
export function loadModels({ sourcePath, snapshotPath, stateDir, userDataDir, env = process.env } = {}) {
  const store = join(stateDir || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "magpie"), SNAPSHOT_DIR_NAME)
  snapshotPath ??= join(store, "models.snapshot.json")
  sourcePath ??= discoverConfig({ userDataDir, env })
  try {
    if (!sourcePath) throw new Error("Desktop model source unavailable")
    const catalog = importModels(readJson(sourcePath))
    try {
      if (JSON.stringify(readJson(snapshotPath)) === JSON.stringify(catalog)) return catalog.models
    } catch {
      // No usable snapshot yet - write one below.
    }
    try {
      if (snapshotPath === join(store, "models.snapshot.json")) mkdirSync(store, { recursive: true, mode: 0o700 })
      saveSnapshot(snapshotPath, catalog)
    } catch {
      // A read-only config dir must not break model discovery.
    }
    return catalog.models
  } catch {
    // Source missing or damaged: keep the last valid catalog, never clear it.
    try { return fromSnapshot(readJson(snapshotPath)) } catch {
      // Fresh install with no snapshot: use the dated reference catalog.
    }
    try { return fromSnapshot(readJson(new URL("./models.default.json", import.meta.url))) } catch {
      // Nothing usable - the plugin's hardcoded fallbacks still apply.
    }
    return {}
  }
}
