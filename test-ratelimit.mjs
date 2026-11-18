// v0.5.1 限流节流：429 软冷却（有界指数退避 + Retry-After 优先）+ 在途并发帽
// 机制移植自 dumate2api 的 src/pool.js（账号池惩罚-恢复状态机），裁剪到
// magpie 插件的单账号形态：
//   - 429 → 软冷却：默认 base 5min × 2^streak，封顶 2h；上游 Retry-After 头
//     优先（夹在 [1s, 封顶]，**不递增** streak——时长是上游定的，不是「又超速
//     了一次」的累计证据）；冷却中再收 429 **不延长**（重试/探测不得把冷却
//     越堆越厚）；一次成功清零 streak（最强恢复证据）。
//   - gate()：冷却内的请求等待剩余时间（≤ maxWaitMs 才等）；剩余 > maxWaitMs
//     或并发帽满等待超时 → 快速失败并给出准确的 retryAfterMs（调用方透传给
//     宿主，让它带着退避信号重试，而不是硬失败）。
//   - 在途并发帽 inFlightMax：单账号同时最多 N 个出站请求（防「70 秒 5 连发」
//     这种突发触发用户级限流）。
//   - MAGPIE_DUMATE_THROTTLE=off：整体关闭（原始透传退出路径）。
// 全部注入时钟与 sleep：零真实等待、零网络。429 行为用 mock 全覆盖，
// **本版本不需要真实网关授权**（真实触发限流有害无益）。
import { createRateLimiter } from "./ratelimit.mjs"

const ok = (n, extra = "") => console.log(`  PASS ${n}${extra ? " · " + extra : ""}`)
const fail = (n, e) => { console.error(`  FAIL ${n}:`, e?.message ?? e); process.exitCode = 1 }

// 可变时钟 + 可记录的 sleep（sleep 推进时钟，模拟真实等待）
function makeClock(start = 1_700_000_000_000) {
  const clock = { now: start, sleeps: [] }
  clock.fn = () => clock.now
  clock.sleep = async (ms) => {
    clock.sleeps.push(ms)
    clock.now += ms
  }
  clock.advance = (ms) => { clock.now += ms }
  return clock
}

const BASE = 5 * 60 * 1000        // softBaseMs 默认
const CAP = 2 * 60 * 60 * 1000    // softMaxMs 默认
const MAXWAIT = 10 * 1000         // maxWaitMs 默认

// ---- 软冷却状态机 -----------------------------------------------------------

console.log("[R1] 首次 429 → 冷却 base 5min；窗口内拒绝并给出准确 retryAfterMs")
try {
  const clock = makeClock()
  const rl = createRateLimiter({ now: clock.fn, sleep: clock.sleep })
  rl.noteRateLimited() // 无 Retry-After
  const blocked = await rl.gate()
  if (blocked.ok !== false) throw new Error("冷却窗口内 gate 应拒绝")
  const expect = BASE - 1 // clock 已被 noteRateLimited 推进 0；窗口 [t0, t0+300000)
  if (blocked.retryAfterMs !== BASE) throw new Error(`retryAfterMs=${blocked.retryAfterMs}，应=300000`)
  clock.advance(BASE + 1)
  if ((await rl.gate()).ok !== true) throw new Error("冷却过期后 gate 应放行")
  ok("首次 429 冷却 300000ms，过期放行，窗口内 retryAfterMs 准确")
} catch (e) { fail("首次 429 冷却", e) }

console.log("[R2] 连续 429（各自冷却自然过期后再撞）→ 指数退避 10min→20min")
try {
  const clock = makeClock()
  const rl = createRateLimiter({ now: clock.fn, sleep: clock.sleep })
  rl.noteRateLimited()
  clock.advance(BASE + 1); rl.gate()          // 第 1 次冷却过期
  rl.noteRateLimited()
  const second = await rl.gate()
  if (second.ok !== false || second.retryAfterMs !== BASE * 2) {
    throw new Error(`第二次冷却应翻倍 600000，得到 ${second.retryAfterMs}`)
  }
  clock.advance(BASE * 2 + 1)
  rl.noteRateLimited()
  const third = await rl.gate()
  if (third.retryAfterMs !== BASE * 4) throw new Error(`第三次应 1200000，得到 ${third.retryAfterMs}`)
  ok("连续 429 指数退避：300000 → 600000 → 1200000")
} catch (e) { fail("指数退避", e) }

console.log("[R3] 退避封顶 2h（softMaxMs）")
try {
  const clock = makeClock()
  const rl = createRateLimiter({ now: clock.fn, sleep: clock.sleep })
  let last
  for (let i = 0; i < 6; i++) {
    rl.noteRateLimited()
    last = await rl.gate()
    clock.advance((last.retryAfterMs ?? 0) + 1)
  }
  // 第 6 次连续：300000*2^5 = 9600000 > 7200000 → 封顶
  if (last.retryAfterMs !== CAP) throw new Error(`应封顶 7200000，得到 ${last.retryAfterMs}`)
  ok("连续超速退避封顶 7200000（2 小时）")
} catch (e) { fail("退避封顶", e) }

console.log("[R4] 上游 Retry-After 优先：夹 [1s, 封顶] 且不递增退避指数")
try {
  const clock = makeClock()
  const rl = createRateLimiter({ now: clock.fn, sleep: clock.sleep })
  rl.noteRateLimited(30 * 1000) // Retry-After: 30
  const blocked = await rl.gate()
  if (blocked.retryAfterMs !== 30 * 1000) throw new Error(`应按上游 30s，得到 ${blocked.retryAfterMs}`)
  clock.advance(30 * 1000 + 1)
  // 上游明说了时长不递增 streak：下一次无 RA 的 429 仍是 base（streak 仍为 0）
  rl.noteRateLimited()
  if ((await rl.gate()).retryAfterMs !== BASE) throw new Error("Retry-After 路径不应递增退避指数")
  // 夹下界：Retry-After: 0.5s → 至少 1s
  const rl2 = createRateLimiter({ now: clock.fn, sleep: clock.sleep })
  rl2.noteRateLimited(500)
  // 下界夹逼看冷却时长本身（500ms ≤ maxWait 时 gate 会等待放行，不产生 retryAfterMs）
  if (rl2.cooldownRemaining() !== 1000) throw new Error(`Retry-After 下界应夹到 1s，得到 ${rl2.cooldownRemaining()}`)
  ok("上游 30s 按它来、不递增指数；0.5s 夹到 1s")
} catch (e) { fail("Retry-After 优先", e) }

console.log("[R5] 冷却中不叠加：已冷却时再收 429 不延长窗口（防重试/探测越堆越厚）")
try {
  const clock = makeClock()
  const rl = createRateLimiter({ now: clock.fn, sleep: clock.sleep })
  rl.noteRateLimited()
  const until1 = rl.cooldownUntil()
  clock.advance(60 * 1000) // 过了 1 分钟
  rl.noteRateLimited()     // 冷却中再来一次 429
  if (rl.cooldownUntil() !== until1) throw new Error("冷却被延长（应保持原 until）")
  ok("冷却中重复 429 不延长窗口")
} catch (e) { fail("冷却不叠加", e) }

console.log("[R6] 成功即清零：冷却过期后一次成功，下次 429 回到 base（不带历史包袱）")
try {
  const clock = makeClock()
  const rl = createRateLimiter({ now: clock.fn, sleep: clock.sleep })
  rl.noteRateLimited()
  clock.advance(BASE + 1)
  rl.noteSuccess()
  rl.noteRateLimited()
  if ((await rl.gate()).retryAfterMs !== BASE) throw new Error("成功清零后应回到 base 300000")
  ok("noteSuccess 清空退避 streak")
} catch (e) { fail("成功清零", e) }

// ---- gate 等待语义 ----------------------------------------------------------

console.log("[R7] gate 等待：剩余 ≤ maxWait → sleep 剩余后放行（waitedMs 准确）")
try {
  const clock = makeClock()
  const rl = createRateLimiter({ now: clock.fn, sleep: clock.sleep, maxWaitMs: MAXWAIT })
  rl.noteRateLimited(8 * 1000) // Retry-After 8s < maxWait 10s
  const g = await rl.gate()
  if (g.ok !== true) throw new Error("剩余 ≤ maxWait 应等待后放行")
  if (g.waitedMs !== 8 * 1000) throw new Error(`waitedMs=${g.waitedMs}，应 8000`)
  if (clock.sleeps.length !== 1 || clock.sleeps[0] !== 8000) throw new Error("sleep 调用不符")
  ok("8s 剩余 → sleep 8000 后放行")
} catch (e) { fail("gate 等待", e) }

console.log("[R8] gate 快速失败：剩余 > maxWait → 不等待，ok:false + 准确 retryAfterMs")
try {
  const clock = makeClock()
  const rl = createRateLimiter({ now: clock.fn, sleep: clock.sleep, maxWaitMs: MAXWAIT })
  rl.noteRateLimited(20 * 60 * 1000) // 20 分钟 >> 10s
  const before = clock.sleeps.length
  const g = await rl.gate()
  if (g.ok !== false) throw new Error("剩余 > maxWait 应快速失败")
  if (g.retryAfterMs !== 20 * 60 * 1000) throw new Error(`retryAfterMs=${g.retryAfterMs}`)
  if (clock.sleeps.length !== before) throw new Error("快速失败不应 sleep")
  ok("20 分钟剩余 → 零 sleep 快速失败 + 准确 retryAfterMs")
} catch (e) { fail("gate 快速失败", e) }

// ---- 在途并发帽 -------------------------------------------------------------

console.log("[R9] 并发帽 inFlightMax=2：第 3 个等待，释放后放行；等待超时快速失败")
try {
  const clock = makeClock()
  const rl = createRateLimiter({ now: clock.fn, sleep: clock.sleep, inFlightMax: 2, maxWaitMs: MAXWAIT })
  const a = rl.acquire()
  const b = rl.acquire()
  if (!a.ok || !b.ok) throw new Error("前两个应直接放行")
  // 第 3 个：并发满 → 等待 maxWait 内无人释放 → 快速失败
  const pending = rl.acquire()
  const p = await pending.wait
  if (p.ok !== false) throw new Error("并发满且无人释放应快速失败")
  if (p.retryAfterMs !== MAXWAIT) throw new Error(`并发等待超时应给 retryAfterMs=${MAXWAIT}，得到 ${p.retryAfterMs}`)
  a.release()
  const c = await rl.acquire().wait
  if (c.ok !== true) throw new Error("释放后应放行")
  ok("并发帽 2：满时等待超时快速失败，释放后放行")
} catch (e) { fail("并发帽", e) }

console.log("[R10] MAGPIE_DUMATE_THROTTLE=off：整体关闭（429 不记账、gate 永远直通）")
try {
  const clock = makeClock()
  const env = { MAGPIE_DUMATE_THROTTLE: "off" }
  const rl = createRateLimiter({ now: clock.fn, sleep: clock.sleep, env })
  rl.noteRateLimited()
  const g = await rl.gate()
  if (g.ok !== true) throw new Error("off 后 gate 应直通")
  if (rl.cooldownUntil() !== 0) throw new Error("off 后 429 不应记账")
  ok("off 开关生效")
} catch (e) { fail("off 开关", e) }

// ---- fetch 集成（mock 上游）-------------------------------------------------

import { DuMatePlugin } from "./index.mjs"
import { capsPath } from "./budget.mjs"
import { mkdirSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const cookies = [{ name: "bce-sessionid", value: "v51", domain: ".baidu.com" }]
const seat = { type: "oauth", cookies, source: "manual", name: "用户甲", accountId: "acc-51" }
const GW = "https://dumate-svc.baidu.com/gateway/apis/v1/chat/completions"
const realFetch = globalThis.fetch

function mockUpstream(responder) {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url ?? ""
    if (url.includes("/api/dumate/app/token/get")) {
      return new Response(JSON.stringify({ code: 0, result: { token: "tok-51", expired_at: new Date(Date.now() + 3600e3).toISOString() } }), { status: 200 })
    }
    if (url.includes("dumate-svc")) {
      return responder()
    }
    return realFetch(input, init)
  }
}
const restore = () => { globalThis.fetch = realFetch }

console.log("[R11] fetch 集成：上游 429 → 透传 + retry-after 头保证存在 + Retryable 标注")
try {
  const dir = join(tmpdir(), "dumate-rl-ix-" + Math.random().toString(36).slice(2, 8))
  mkdirSync(dir, { recursive: true })
  const plugin = await DuMatePlugin({ directory: dir })
  mockUpstream(() => new Response(
    JSON.stringify({ error: { code: "user_rate_limit_exceeded", message: "用户级限流" } }),
    { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "30" } },
  ))
  const loader = await plugin.auth.loader(async () => seat)
  const r = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "glm-53", messages: [] }) })
  if (r.status !== 429) throw new Error("HTTP " + r.status)
  if (r.headers.get("retry-after") !== "30") throw new Error("retry-after 头丢失")
  if (!r.headers.get("x-magpie-dumate-retryable")) throw new Error("缺 Retryable 标注（宿主无法知道可重试）")
  const body = await r.json()
  if (body?.error?.code !== "user_rate_limit_exceeded") throw new Error("上游错误体未透传")
  // 冷却已记账：立即再发 → 插件本地快速拒绝（不再打上游），带 retry-after
  let upstreamCalls = 0
  mockUpstream(() => { upstreamCalls++; return new Response("{}", { status: 200 }) })
  const r2 = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "glm-53", messages: [] }) })
  if (r2.status !== 429) throw new Error(`冷却内第二个请求应本地 429，得到 ${r2.status}`)
  if (r2.headers.get("x-magpie-dumate-retryable") !== "1") throw new Error("本地 429 缺 Retryable")
  if (r2.headers.get("retry-after") === null) throw new Error("本地 429 缺 retry-after")
  if (upstreamCalls !== 0) throw new Error("冷却内请求不应打到上游（扎堆防护失效）")
  rmSync(dir, { recursive: true, force: true })
  ok("上游 429 透传+标注；冷却内本地 429 拒绝且上游零调用")
} catch (e) { fail("fetch 429 集成", e) } finally { restore() }

console.log("[R12] fetch 集成：429 恢复后正常放行（成功清零退避）")
try {
  const dir = join(tmpdir(), "dumate-rl-ix2-" + Math.random().toString(36).slice(2, 8))
  mkdirSync(dir, { recursive: true })
  const plugin = await DuMatePlugin({ directory: dir })
  // Retry-After: 2s ≤ maxWait → 插件本地等待 2s 后放行（测试用真实时钟，2s 可接受）
  let responses = 0
  mockUpstream(() => {
    responses++
    if (responses === 1) {
      return new Response(JSON.stringify({ error: { code: "user_rate_limit_exceeded" } }), { status: 429, headers: { "Retry-After": "2" } })
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })
  })
  const loader = await plugin.auth.loader(async () => seat)
  const r1 = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "glm-53", messages: [] }) })
  if (r1.status !== 429) throw new Error("第一次应 429")
  const t0 = Date.now()
  const r2 = await loader.fetch(GW, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "glm-53", messages: [] }) })
  const waited = Date.now() - t0
  if (r2.status !== 200) throw new Error(`恢复后应 200，得到 ${r2.status}`)
  if (waited < 1900 || waited > 6000) throw new Error(`等待异常: ${waited}ms`)
  rmSync(dir, { recursive: true, force: true })
  ok(`短 Retry-After → 插件本地等待 ${Math.round(waited / 100) / 10}s 后重发成功（用户无感）`)
} catch (e) { fail("fetch 恢复集成", e) } finally { restore() }

console.log(process.exitCode ? "\n== 有失败项 ==" : "\n== 全部通过 ==")
