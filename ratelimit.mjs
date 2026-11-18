// v0.5.1 限流节流（机制移植自 dumate2api 的账号池惩罚-恢复状态机
// wearetheone777/dumate2api src/pool.js，裁剪到 magpie 插件的单账号形态）。
//
// 背景：百度搭子云端网关对单账号有**用户级突发限流**（user_rate_limit_exceeded，
// 短窗口连发 4-5 条即 429，滚动窗口约 20 分钟恢复；日额度本身极充裕）。0.5.0
// 及之前插件把上游 429 原样透传且无可重试信号（magpie 显示 retryable=false
// 硬失败）。本模块把「撞了之后怎么办」工程化：
//
//   - 429 → 软冷却：默认 base 5min × 2^streak，封顶 2h。三条纪律沿用
//     dumate2api 的实战教训：
//       1. 上游 Retry-After 优先：夹在 [1s, 封顶]，**不递增** streak——时长是
//          上游定的，不是「又超速了一次」的累计证据；30s 的排队条件不被放大
//          成 5 分钟。
//       2. 冷却中不叠加：已冷却时再收 429 不延长窗口（重试与并发探测不得把
//          冷却越堆越厚）。
//       3. 一次成功清零 streak（最强恢复证据）。
//   - gate()：冷却内的请求分两路——剩余 ≤ maxWaitMs（默认 10s）则本地等待
//     后放行（短排队，用户无感）；剩余 > maxWaitMs 则快速失败并给出准确的
//     retryAfterMs，由调用方透传给 magpie 宿主带退避信号重试（不再硬失败）。
//   - 在途并发帽 acquire/release：单账号同时最多 N 个出站请求（默认 2），
//     满时等待 maxWaitMs 内的释放，超时快速失败——「70 秒 5 连发」这类突发
//     在本地被压平，而不是放出去吃 429。
//   - MAGPIE_DUMATE_THROTTLE=off：整体关闭（原始透传退出路径）。
//
// 全部状态是**进程内存态**（dumate2api 落盘是因为多进程共享账号池；本插件
// 单进程单账号，重启丢冷却态的代价远小于多一份落盘卫生负担）。时钟与 sleep
// 均可注入：测试零真实等待、零网络。

const DEFAULTS = {
  softBaseMs: 5 * 60 * 1000,          // 软冷却基数（429 首次）
  softMaxMs: 2 * 60 * 60 * 1000,      // 软冷却封顶（2 小时）
  maxWaitMs: 10 * 1000,               // gate/acquire 的最大本地等待
  inFlightMax: 2,                     // 在途并发帽
}

/** 解析 Retry-After 头（秒数或 HTTP 日期）为毫秒；无效/缺失返回 null。 */
export function parseRetryAfterMs(value, now = Date.now()) {
  if (typeof value !== "string" || !value.trim()) return null
  const v = value.trim()
  if (/^\d+$/.test(v)) return Number(v) * 1000
  const dateMs = Date.parse(v)
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - now)
  return null
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createRateLimiter(opts = {}) {
  const env = opts.env ?? process.env
  const off = String(env?.MAGPIE_DUMATE_THROTTLE ?? "").trim().toLowerCase() === "off"
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? defaultSleep
  const softBaseMs = opts.softBaseMs ?? DEFAULTS.softBaseMs
  const softMaxMs = opts.softMaxMs ?? DEFAULTS.softMaxMs
  const maxWaitMs = opts.maxWaitMs ?? DEFAULTS.maxWaitMs
  const inFlightMax = opts.inFlightMax ?? DEFAULTS.inFlightMax

  let cooldownDeadlineMs = 0
  let cooldownReason = ""
  let softStreak = 0
  let inFlight = 0

  const enabled = () => String((opts.env ?? env)?.MAGPIE_DUMATE_THROTTLE ?? "").trim().toLowerCase() !== "off"

  /** 当前冷却剩余毫秒（0 = 不在冷却） */
  function cooldownRemaining(nowMs = now()) {
    if (!enabled()) return 0
    return Math.max(0, cooldownDeadlineMs - nowMs)
  }

  /** 供测试/诊断读取冷却截止时刻（off 时恒 0） */
  function cooldownUntil() {
    return enabled() ? cooldownDeadlineMs : 0
  }

  /**
   * 记一次 429。retryAfterMs 为上游 Retry-After 头的毫秒解析（null = 无头）。
   * 纪律：explicit 不递增 streak；冷却中不延长窗口。
   */
  function noteRateLimited(retryAfterMs = null, reason = "user_rate_limit_exceeded") {
    if (!enabled()) return
    const t = now()
    const explicit = Number(retryAfterMs)
    // 冷却中不叠加：任何来源的 429 都不延长已生效的窗口。
    if (cooldownDeadlineMs > t) return
    let d
    if (Number.isFinite(explicit) && explicit > 0) {
      d = Math.min(Math.max(explicit, 1000), softMaxMs)
    } else {
      const shift = Math.min(softStreak, 16) // 防 streak 溢出
      d = Math.min(softBaseMs * Math.pow(2, shift), softMaxMs)
      softStreak++
    }
    cooldownDeadlineMs = t + d
    cooldownReason = reason
  }

  /** 一次成功是最强恢复证据：清退避 streak（不碰已生效的冷却截止——各自到期）。 */
  function noteSuccess() {
    if (!enabled()) return
    softStreak = 0
  }

  /**
   * 出站前闸门：冷却内则等待剩余（≤ maxWaitMs）或快速失败。
   * @returns {{ok:true, waitedMs:number} | {ok:false, retryAfterMs:number, reason:string}}
   */
  async function gate() {
    if (!enabled()) return { ok: true, waitedMs: 0 }
    const remaining = cooldownRemaining()
    if (remaining <= 0) return { ok: true, waitedMs: 0 }
    if (remaining > maxWaitMs) {
      return { ok: false, retryAfterMs: remaining, reason: cooldownReason || "rate_limited" }
    }
    await sleep(remaining)
    return { ok: true, waitedMs: remaining }
  }

  /**
   * 在途名额：并发满时等待 maxWaitMs 内的释放；超时快速失败。
   * @returns {{ok:true, release:()=>void} | {ok:false, retryAfterMs:number, wait:Promise}}
   *   - 同步命中名额：{ok:true, release}
   *   - 需等待：{ok:false, wait}——wait resolve 为 {ok:true, release} 或
   *     {ok:false, retryAfterMs}（调用方 await 后分支）。快速失败路径同步可判
   *     （wait resolve 值带 ok 字段，两种路径统一 await）。
   */
  function acquire() {
    if (!enabled()) {
      const free = { ok: true, release: () => {} }
      return { ...free, wait: Promise.resolve(free) }
    }
    if (inFlight < inFlightMax) {
      inFlight++
      const held = { ok: true, release: () => { inFlight = Math.max(0, inFlight - 1) } }
      return { ...held, wait: Promise.resolve(held) }
    }
    // 并发满：等待 maxWaitMs 内的释放（200ms 轮询），超时快速失败。
    const wait = (async () => {
      const deadline = now() + maxWaitMs
      while (now() < deadline) {
        await sleep(200)
        if (inFlight < inFlightMax) {
          inFlight++
          return { ok: true, release: () => { inFlight = Math.max(0, inFlight - 1) } }
        }
      }
      return { ok: false, retryAfterMs: maxWaitMs }
    })()
    return { ok: false, retryAfterMs: maxWaitMs, wait }
  }

  return { gate, acquire, noteSuccess, noteRateLimited, cooldownRemaining, cooldownUntil }
}
