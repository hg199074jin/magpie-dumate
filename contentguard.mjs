// v0.5.2 上游内容过滤拦截的识别与提示。
//
// 背景（2026-11-18 本机 magpie usage.jsonl 实证）：会话上下文涨到约 58.7 万 tokens 后，
// `dumate/deepseek-v41-flash` 连续 4 次返回 out=47 tokens、stop=content_filter ——
// 上游把回答替换成固定话术「作为一个人工智能语言模型，我还没学习如何回答这个问题…」。
// 同一模型在 6.4k 输入时正常（out=1948），glm-53 在 53 万输入正常（stop=stop）。
// 用户侧看到的就是"答非所问"，且没有任何线索指向内容过滤。
//
// 本模块只做两件事，都是**只读旁路**：
//   1. tapContentFilter —— 流式 SSE：原始分块逐字节透传给下游，只在检测到
//      `content_filter` 时于 `[DONE]` 之前注入一条提示事件（说明是上游过滤 +
//      给出可操作建议）。正常流零改写。
//   2. isContentFiltered —— 非流式：判断 choices[].finish_reason 是否 content_filter，
//      由调用方转成明确的 422 说明。
//
// 作用范围有意收窄：只有 GUARDED_MODELS（当前仅 deepseek-v41-flash，即有实测
// 证据的模型）才拦截提示；其他模型零改动。MAGPIE_DUMATE_CONTENT_GUARD=off 关闭。
//
// 与 context cap 的分工：models.mjs 把该模型的目录 context 下调到 512k（让宿主在
// 安全区内先压缩），本模块是"万一仍然撞上"时的可解释出口。

/** 有实测证据会出现上游内容过滤替换的模型（小写）。 */
export const GUARDED_MODELS = new Set(["deepseek-v41-flash"])

/** 注入 / 返回给用户的提示文本（中文，含可操作建议）。 */
export const FILTER_NOTICE =
  "\n\n> ⚠️ DuMate 上游内容过滤器拦截了本次回答（该模型在超长上下文下会把回复替换成固定话术）。建议：开一个新会话，或改用 glm-53。"

export const FILTER_MESSAGE =
  "DuMate 上游内容过滤器拦截了本次回答（模型在该网关的超长上下文下会返回固定话术而非答案）。建议：开一个新会话，或改用 glm-53。"

const enabled = (env = process.env) =>
  String(env?.MAGPIE_DUMATE_CONTENT_GUARD ?? "").trim().toLowerCase() !== "off"

/** 非流式响应体 → 是否被上游内容过滤替换。 */
export function isContentFiltered(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false
  const choices = Array.isArray(payload.choices) ? payload.choices : []
  for (const c of choices) {
    if (!c || typeof c !== "object") continue
    if (String(c.finish_reason ?? "") === "content_filter") return true
    // 兼容部分网关的 stop_reason 命名
    if (String(c.stop_reason ?? "") === "content_filter") return true
  }
  return false
}

function noticeEvent() {
  const payload = {
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: FILTER_NOTICE }, finish_reason: null }],
  }
  return `data: ${JSON.stringify(payload)}\n\n`
}

const enc = () => new TextEncoder()

/**
 * 流式旁路：原始分块零改动直通，仅在检测到 content_filter 时于 [DONE] 前注入提示。
 * 实现要点：
 *   - 尾部保留一个小窗口（4 KiB）用于跨分块检测 content_filter；
 *   - 含 `[DONE]` 的分块被**暂扣**：先发提示（若命中）、再发原分块，保证 [DONE] 最后；
 *   - 流结束时若从未见到 [DONE]，在关闭前补发提示（若命中）；
 *   - 正常流逐字节一致（没有任何注入）。
 */
export function tapContentFilter(res, { env = process.env, notice = true } = {}) {
  if (!enabled(env)) return res.body
  const decoder = new TextDecoder()
  let tail = ""
  let filtered = false
  let done = false
  let injected = false

  const emitNotice = (controller) => {
    if (!notice || injected || !filtered) return
    injected = true
    controller.enqueue(enc().encode(noticeEvent()))
  }

  return res.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true })
      tail = (tail + text).slice(-4096)
      if (tail.includes("content_filter")) filtered = true
      const hasDone = text.includes("[DONE]")
      if (hasDone && !done) {
        done = true
        // 先提示，再原样发出含 [DONE] 的分块
        emitNotice(controller)
      }
      controller.enqueue(chunk)
    },
    flush(controller) {
      // 流以非 [DONE] 方式结束：仍要给出提示（若有过滤证据）
      if (!done) emitNotice(controller)
    },
  }))
}
