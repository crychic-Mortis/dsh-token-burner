/**
 * dsh-token-burner —— 批量/并发制造 token 消耗的 DSH 插件
 * ============================================================================
 * 注册一个 agent 工具 `token_burn`：并发发起 N 个真实的 LLM stream 调用，
 * 每个调用让模型生成大量文本（maxTokens 拉满 + 引导长输出），从而快速
 * 消耗 input/output token。用途：压测、触发限流、测计费上限、观察并发行为。
 *
 * 设计要点（与 dsh-ops 一致的纯对象工具定义，零 @deepseek-ai/* value import）：
 *   - 通过 `ctx.llm.stream()` 发起真实模型调用（provider/model 走 agentDefaultModel，
 *     缺省 deepseek-official / deepseek-v4-pro）；
 *   - 从流的 `usage` chunk 读 inputTokens / outputTokens / totalTokens 做统计；
 *   - 并发用简单 worker 池，受 config 的 maxConcurrency / maxRequests 硬上限约束；
 *   - 全部走 `exec.signal` 取消，工具被中止时立即停掉在途请求。
 */

/** Cordis 插件名（与 package.json 的 name 一致）。 */
export const name = 'dsh-token-burner'

/** 工具注入的宿主服务（webServer 用于 health 端点，验证加载状态）。 */
export const inject = ['llm', 'tools']

/** 默认 provider / model（当 agentDefaultModel 服务缺席时兜底）。 */
const FALLBACK_PROVIDER = 'deepseek-official'
const FALLBACK_MODEL = 'deepseek-v4-pro'

/** 让模型尽可能多输出的默认引导词。 */
const DEFAULT_BURN_PROMPT = [
  '请详细、全面、分章节地论述"人工智能对未来十年人类社会的影响"。',
  '要求：至少 8 个大章节，每章至少 5 个自然段；',
  '尽可能展开论证、举例、对比、引用观点；不要省略、不要总结，',
  '一直写下去，能写多长写多长。',
].join('')

/**
 * 从 agentDefaultModel 服务读当前默认 provider/model；缺席则用兜底值。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {{provider: string, model: string}}
 */
function resolveRoute(ctx) {
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (selection?.provider && selection?.model) {
      return { provider: String(selection.provider), model: String(selection.model) }
    }
  } catch {
    /* 服务缺席或读取失败，走兜底 */
  }
  return { provider: FALLBACK_PROVIDER, model: FALLBACK_MODEL }
}

/**
 * 断言数值参数落在合法区间，否则抛可读错误。
 * @param {string} label
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} max
 * @returns {number}
 */
function boundInt(label, value, fallback, max) {
  const n = value === undefined || value === null ? fallback : Number(value)
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`token_burn: ${label} 必须是正整数，收到 ${JSON.stringify(value)}`)
  }
  if (n > max) {
    throw new Error(`token_burn: ${label} 超过上限 ${max}，收到 ${n}`)
  }
  return n
}

/**
 * 单个 LLM 调用：流式消费并统计 usage。
 * @param {object} deps
 * @param {object} deps.llm
 * @param {string} deps.provider
 * @param {string} deps.model
 * @param {number} deps.maxTokens
 * @param {string} deps.prompt
 * @param {AbortSignal} deps.signal
 * @returns {Promise<{inputTokens:number, outputTokens:number, totalTokens:number, ok:boolean, error?:string}>}
 */
async function runOneCall({ llm, provider, model, maxTokens, prompt, signal }) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
  let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  try {
    for await (const chunk of llm.stream({
      provider,
      model,
      messages,
      maxTokens,
      signal,
    })) {
      signal?.throwIfAborted()
      if (chunk?.type === 'usage' && chunk.usage) {
        usage = {
          inputTokens: Number(chunk.usage.inputTokens) || 0,
          outputTokens: Number(chunk.usage.outputTokens) || 0,
          totalTokens: Number(chunk.usage.totalTokens)
            || (Number(chunk.usage.inputTokens) || 0) + (Number(chunk.usage.outputTokens) || 0),
        }
      }
    }
    return { ...usage, ok: true }
  } catch (error) {
    if (signal?.aborted) {
      return { ...usage, ok: false, error: 'aborted' }
    }
    return { ...usage, ok: false, error: error?.message ?? String(error) }
  }
}

/**
 * 并发 worker 池：把 requests 个任务按 concurrency 并发度跑完。
 * @param {number} total
 * @param {number} concurrency
 * @param {(index:number)=>Promise<T>} worker
 * @returns {Promise<T[]>}
 */
async function runPool(total, concurrency, worker) {
  const results = new Array(total)
  let cursor = 0
  const lanes = Array.from({ length: Math.min(concurrency, total) }, async () => {
    while (cursor < total) {
      const index = cursor++
      results[index] = await worker(index)
    }
  })
  await Promise.all(lanes)
  return results
}

/**
 * 工具输出 schema（object 根，满足 dsh-tools 的 JSON Schema 约束）。
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    requests: { type: 'integer' },
    concurrency: { type: 'integer' },
    succeeded: { type: 'integer' },
    failed: { type: 'integer' },
    inputTokens: { type: 'integer' },
    outputTokens: { type: 'integer' },
    totalTokens: { type: 'integer' },
    durationMs: { type: 'integer' },
    provider: { type: 'string' },
    model: { type: 'string' },
    failures: {
      type: 'array',
      items: { type: 'string' },
    },
  },
}

/**
 * 把结果值渲染成工具返回的文本块。
 * @param {unknown} _args
 * @param {object} value
 * @returns {{type:'text', text:string}[]}
 */
function renderResult(_args, value) {
  const lines = [
    `token_burn 完成：${value.succeeded}/${value.requests} 次成功，${value.failed} 次失败`,
    `provider=${value.provider}  model=${value.model}`,
    `并发=${value.concurrency}  耗时=${value.durationMs}ms`,
    `input tokens=${value.inputTokens}  output tokens=${value.outputTokens}  total=${value.totalTokens}`,
  ]
  if (value.failures?.length > 0) {
    lines.push(`失败明细：${value.failures.join(' | ')}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * 注册 health 端点：GET /token-burner/api/health → { ok, version, route }。
 * 用于验证插件是否被 loader 加载、能否读到默认模型路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {() => void} disposer
 */
function installHealthApi(ctx) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: '/token-burner',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/token-burner/api/health') {
        const route = resolveRoute(ctx)
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true, version: '1.0.0', route }))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'not found' }))
    },
  })
}

/**
 * 插件入口：注册 token_burn 工具 + health 端点。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 */
export function apply(ctx, config) {
  const cfg = {
    defaultConcurrency: 8,
    defaultRequests: 16,
    defaultMaxTokens: 8192,
    maxConcurrency: 64,
    maxRequests: 512,
    ...config,
  }

  // health 端点（webServer 可选，TUI/headless 环境缺席时跳过）。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => installHealthApi(webCtx), 'dsh-token-burner: http health')
  })

  ctx.tools.register({
    name: 'token_burn',
    description:
      '并发调用 LLM 批量制造 token 消耗（压测 / 触发限流 / 测计费上限）。'
      + '一次发起 requests 个真实的模型生成请求，按 concurrency 并发度同时跑，'
      + '每个请求让模型生成大量文本。返回本次消耗的 input/output/total token 与成功率。'
      + '注意：这会真实消耗账号的 token 额度，请确认后再调用。',
    parameters: {
      type: 'object',
      properties: {
        requests: {
          type: 'integer',
          description: `总请求数（默认 ${cfg.defaultRequests}，上限 ${cfg.maxRequests}）。`,
        },
        concurrency: {
          type: 'integer',
          description: `并发度（默认 ${cfg.defaultConcurrency}，上限 ${cfg.maxConcurrency}）。`,
        },
        maxTokens: {
          type: 'integer',
          description: `每个请求的最大输出 token 数（默认 ${cfg.defaultMaxTokens}）。越大单次消耗越多。`,
        },
        prompt: {
          type: 'string',
          description: '可选：每个请求要模型生成的文本主题。缺省用内置的"长文论述"引导词。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: renderResult,
    },
    async execute(args, exec) {
      const requests = boundInt('requests', args?.requests, cfg.defaultRequests, cfg.maxRequests)
      const concurrency = boundInt('concurrency', args?.concurrency, cfg.defaultConcurrency, cfg.maxConcurrency)
      const maxTokens = boundInt('maxTokens', args?.maxTokens, cfg.defaultMaxTokens, 1_000_000)
      const prompt = typeof args?.prompt === 'string' && args.prompt.trim() !== ''
        ? args.prompt
        : DEFAULT_BURN_PROMPT
      const route = resolveRoute(ctx)

      exec.signal?.throwIfAborted()
      const startedAt = Date.now()

      const results = await runPool(requests, concurrency, () =>
        runOneCall({
          llm: ctx.llm,
          provider: route.provider,
          model: route.model,
          maxTokens,
          prompt,
          signal: exec.signal,
        }),
      )

      const succeeded = results.filter((r) => r.ok).length
      const failed = results.length - succeeded
      const sum = (key) => results.reduce((acc, r) => acc + (Number(r[key]) || 0), 0)
      const failures = results
        .filter((r) => !r.ok && r.error)
        .map((r) => r.error)
        .slice(0, 20)

      return {
        requests,
        concurrency,
        succeeded,
        failed,
        inputTokens: sum('inputTokens'),
        outputTokens: sum('outputTokens'),
        totalTokens: sum('totalTokens'),
        durationMs: Date.now() - startedAt,
        provider: route.provider,
        model: route.model,
        failures,
      }
    },
  })
}
