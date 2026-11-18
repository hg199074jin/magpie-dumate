// v0.5.2：上游内容过滤拦截的识别与提示 + deepseek 上下文安全上限
// 真实事故驱动（2026-11-18 本机 magpie 用量记录实证）：
//   - 本机会话上下文涨到约 58.7 万 tokens 后，`dumate/deepseek-v41-flash` 连续 4 次
//     返回 out=47 tokens、stop=`content_filter`——上游把回答替换成固定话术
//     「作为一个人工智能语言模型，我还没学习如何回答这个问题…」，用户侧表现为
//     "答非所问"。同一模型在 6.4k 输入时正常（out=1948），glm-53 在 53 万输入正常。
//   - 失败区间实测：52.3 万正常 / 57.5 万起失败（阈值未知，UNKNOWN）→ 目录 context
//     从注册表宣称的 1000k 下调到 512k，让宿主在安全区内先压缩上下文。
//   - 另加一层：命中 content_filter 时给调用方明确提示（流式注入提示事件 /
//     非流式返回 422 说明），而不是让用户看到一句莫名其妙的固定话术。
// 全部离线（mock 上游），不需要真实网关授权。
import { DuMatePlugin } from "./index.mjs"
import { importModels, SAFE_CONTEXT_CAPS } from "./models.mjs"
import {
  tapContentFilter, isContentFiltered, GUARDED_MODELS, FILTER_NOTICE,
} from "./contentguard.mjs"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const ok = (n, extra = "") => console.log(`  PASS ${n}${extra ? " · " + extra : ""}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

const model = (id, ctx, out) => ({
  id, name: id, limit: { context: ctx, output: out },
  modalities: { input: ["text"], output: ["text"] },
})
const source = (models) => ({ provider: { QianfanPersonalQuota: { models } } })

console.log("[F1] 目录 context 安全上限：deepseek-v41-flash 1000k → 512k，其他模型不动")
try {
  if (SAFE_CONTEXT_CAPS["deepseek-v41-flash"] !== 512_000) {
    throw new Error("SAFE_CONTEXT_CAPS 未声明 deepseek-v41-flash = 512000")
  }
  const { models } = importModels(source({
    "deepseek-v41-flash": model("deepseek-v41-flash", 1_000_000, 384_000),
    "glm-53": model("glm-53", 1_000_000, 128_000),
    "kimi-k31": model("kimi-k31", 1_048_576, 1_048_576),
  }))
  if (models["deepseek-v41-flash"].limit.context !== 512_000) {
    throw new Error(`deepseek context 未下调，得到 ${models["deepseek-v41-flash"].limit.context}`)
  }
  if (models["glm-53"].limit.context !== 1_000_000) throw new Error("glm-53 被误改")
  if (models["kimi-k31"].limit.context !== 1_048_576) throw new Error("kimi 被误改")
  // 输出上限不受影响
  if (models["deepseek-v41-flash"].limit.output !== 384_000) throw new Error("output 被误改")
  ok("deepseek-v41-flash → 512000，glm-53/kimi-k31 原样，output 不变")
} catch (e) { fail("目录安全上限", e) }

console.log("[F2] isContentFiltered：识别非流式 content_filter，普通回答不误判")
try {
  if (!isContentFiltered({ choices: [{ finish_reason: "content_filter", message: { content: "x" } }] })) {
    throw new Error("content_filter 未识别")
  }
  if (isContentFiltered({ choices: [{ finish_reason: "stop" }] })) throw new Error("stop 被误判")
  if (isContentFiltered({ choices: [{ finish_reason: "tool_calls" }] })) throw new Error("tool_calls 被误判")
  if (isContentFiltered(null) || isContentFiltered("x")) throw new Error("非法输入应返回 false")
  ok("只认 content_filter")
} catch (e) { fail("isContentFiltered", e) }

console.log("[F3] 流式：content_filter 的流注入明确提示，且原始事件与 [DONE] 顺序保持")
try {
  const sse =
    'data: {"choices":[{"index":0,"delta":{"content":"作为一个人工智能语言模型"}}]}\n\n' +
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]}\n\n' +
    "data: [DONE]\n\n"
  const src = new ReadableStream({
    start(c) {
      // 分片喂入，模拟真实流
      c.enqueue(new TextEncoder().encode(sse.slice(0, 40)))
      c.enqueue(new TextEncoder().encode(sse.slice(40, 160)))
      c.enqueue(new TextEncoder().encode(sse.slice(160)))
      c.close()
    },
  })
  const res = new Response(src, { status: 200, headers: { "Content-Type": "text/event-stream" } })
  const out = await new Response(tapContentFilter(res, {})).text()
  const MARK = "上游内容过滤器拦截了本次回答"
  if (!out.includes(MARK)) throw new Error("未注入提示事件")
  if (!out.includes("作为一个人工智能语言模型")) throw new Error("原始事件被丢弃")
  if (!out.includes('"finish_reason":"content_filter"')) throw new Error("原始 finish 事件被破坏")
  const iNotice = out.indexOf(MARK)
  const iDone = out.indexOf("[DONE]")
  if (!(iNotice > 0 && iDone > iNotice)) throw new Error("提示事件应在 [DONE] 之前")
  if (!out.trimEnd().endsWith("[DONE]")) throw new Error("[DONE] 必须是最后一条")
  ok("提示注入到 [DONE] 前，原始事件逐字保留")
} catch (e) { fail("流式提示", e) }

console.log("[F4] 流式：正常回答逐字节透传（零改写）")
try {
  const sse =
    'data: {"choices":[{"index":0,"delta":{"content":"正常回答"}}]}\n\n' +
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n"
  const bytes = new TextEncoder().encode(sse)
  const res = new Response(new ReadableStream({
    start(c) { c.enqueue(bytes); c.close() },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } })
  const out = new Uint8Array(await new Response(tapContentFilter(res, {})).arrayBuffer())
  if (out.length !== bytes.length) throw new Error(`逐字节保真被破坏：${bytes.length} → ${out.length}`)
  for (let i = 0; i < bytes.length; i++) if (out[i] !== bytes[i]) throw new Error(`第 ${i} 字节被改写`)
  ok("正常流零改写（含 [DONE]）")
} catch (e) { fail("正常流保真", e) }

// ---- fetch 集成 -------------------------------------------------------------

const cookies = [{ name: "bce-sessionid", value: "v52", domain: ".baidu.com" }]
const seat = { type: "oauth", cookies, source: "manual", name: "用户甲", accountId: "acc-52" }
const GW = "https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions"
const realFetch = globalThis.fetch

function mock(responder) {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url ?? ""
    if (url.includes("/api/dumate/app/token/get")) {
      return new Response(JSON.stringify({ code: 0, result: { token: "tok-52", expired_at: new Date(Date.now() + 3600e3).toISOString() } }), { status: 200 })
    }
    if (url.includes("dumate-svc")) return responder()
    return realFetch(input, init)
  }
}
const restore = () => { globalThis.fetch = realFetch }

console.log("[F5] fetch 集成：deepseek 流式 content_filter → 用户看到明确提示")
try {
  const dir = join(tmpdir(), "dumate-cg-" + Math.random().toString(36).slice(2, 8))
  mkdirSync(dir, { recursive: true })
  const plugin = await DuMatePlugin({ directory: dir })
  const sse =
    'data: {"choices":[{"index":0,"delta":{"content":"模板话术"}}]}\n\n' +
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]}\n\n' +
    "data: [DONE]\n\n"
  mock(() => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close() },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } }))
  const loader = await plugin.auth.loader(async () => seat)
  const r = await loader.fetch(GW, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v41-flash", stream: true, messages: [{ role: "user", content: "hi" }] }),
  })
  if (r.status !== 200) throw new Error("HTTP " + r.status)
  const out = await r.text()
  if (!out.includes("上游内容过滤器拦截了本次回答")) throw new Error("未注入提示")
  rmSync(dir, { recursive: true, force: true })
  ok("流式上游 content_filter → 提示已注入，状态码保持 200")
} catch (e) { fail("集成 流式", e) } finally { restore() }

console.log("[F6] fetch 集成：deepseek 非流式 content_filter → 422 + 可操作说明")
try {
  const dir = join(tmpdir(), "dumate-cg2-" + Math.random().toString(36).slice(2, 8))
  mkdirSync(dir, { recursive: true })
  const plugin = await DuMatePlugin({ directory: dir })
  mock(() => new Response(JSON.stringify({
    model: "deepseek-v41-flash",
    choices: [{ finish_reason: "content_filter", message: { role: "assistant", content: "作为一个人工智能语言模型…" } }],
  }), { status: 200, headers: { "Content-Type": "application/json" } }))
  const loader = await plugin.auth.loader(async () => seat)
  const r = await loader.fetch(GW, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v41-flash", stream: false, messages: [{ role: "user", content: "hi" }] }),
  })
  if (r.status !== 422) throw new Error(`应 422，得到 ${r.status}`)
  const body = await r.json()
  if (!/内容过滤|content_filter/i.test(body?.error?.message ?? "")) throw new Error("错误说明不明确: " + JSON.stringify(body).slice(0, 120))
  if (!/新会话|glm-53/.test(body?.error?.message ?? "")) throw new Error("缺少可操作建议")
  rmSync(dir, { recursive: true, force: true })
  ok("非流式 content_filter → 422 + 明确建议")
} catch (e) { fail("集成 非流式", e) } finally { restore() }

console.log("[F7] 保护范围：MAGPIE_DUMATE_CONTENT_GUARD=off 或非受限模型 → 零改写")
try {
  // off 开关：deepseek 的 content_filter 原样透传（不发提示、不改状态）
  process.env.MAGPIE_DUMATE_CONTENT_GUARD = "off"
  const dir = join(tmpdir(), "dumate-cg3-" + Math.random().toString(36).slice(2, 8))
  mkdirSync(dir, { recursive: true })
  const plugin = await DuMatePlugin({ directory: dir })
  const sse =
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"content_filter"}]}\n\n' +
    "data: [DONE]\n\n"
  mock(() => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close() },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } }))
  const loader = await plugin.auth.loader(async () => seat)
  const r = await loader.fetch(GW, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v41-flash", stream: true, messages: [{ role: "user", content: "hi" }] }),
  })
  const out = await r.text()
  if (out !== sse) throw new Error("off 开关未生效（仍被改写）")
  delete process.env.MAGPIE_DUMATE_CONTENT_GUARD
  restore()
  // 非受限模型：glm-53 的 content_filter 原样透传
  const dir2 = join(tmpdir(), "dumate-cg4-" + Math.random().toString(36).slice(2, 8))
  mkdirSync(dir2, { recursive: true })
  const plugin2 = await DuMatePlugin({ directory: dir2 })
  mock(() => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close() },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } }))
  const loader2 = await plugin2.auth.loader(async () => seat)
  const r2 = await loader2.fetch(GW, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "glm-53", stream: true, messages: [{ role: "user", content: "hi" }] }),
  })
  const out2 = await r2.text()
  if (out2 !== sse) throw new Error("非受限模型被误改写")
  if (!GUARDED_MODELS.has("deepseek-v41-flash") || GUARDED_MODELS.has("glm-53")) {
    throw new Error("GUARDED_MODELS 范围不符")
  }
  rmSync(dir, { recursive: true, force: true })
  rmSync(dir2, { recursive: true, force: true })
  ok("off 开关 + 非受限模型（glm-53）均零改写")
} catch (e) { fail("保护范围", e) } finally { restore(); delete process.env.MAGPIE_DUMATE_CONTENT_GUARD }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
