/**
 * dsh-token-burner —— 批量/并发制造 token 消耗的 DSH 插件
 * ============================================================================
 * 注册一个 agent 工具 `token_burn`：并发发起 N 个真实的 LLM stream 调用，
 * 每个调用内部再连续追问 rounds 轮（历史全量回传），让模型生成大量文本，
 * 从而在同样的请求数下消耗成倍的 token。用途：压测、触发限流、测计费上限、
 * 观察并发与长上下文行为。
 *
 * 设计要点（与 dsh-ops 一致的纯对象工具定义，零 @deepseek-ai/* value import）：
 *   - 通过 `ctx.llm.stream()` 发起真实模型调用，provider/model 一律跟随
 *     `agentDefaultModel`（会话当前选中的模型），不额外指定、不偷偷换模型；
 *   - 每个请求是多轮对话：第 n 轮把前 n-1 轮的完整历史再发一遍，输入 token 随轮数
 *     近似平方增长，输出 token 随轮数线性增长；
 *   - 从流的 `usage` chunk 读 inputTokens / outputTokens / totalTokens 做统计，
 *     多轮的 usage 逐轮累加；
 *   - 并发用简单 worker 池，受 config 的 maxConcurrency / maxRequests / maxRounds 硬上限约束；
 *   - 全部走 `exec.signal` 取消，工具被中止时立即停掉在途请求。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** Cordis 插件名（与 package.json 的 name 一致）。 */
export const name = 'dsh-token-burner'

/** 工具注入的宿主服务（webServer 用于 health 端点，验证加载状态）。 */
export const inject = ['llm', 'tools']

/** 默认 provider / model（当 agentDefaultModel 服务缺席时兜底，取最便宜的档）。 */
const FALLBACK_PROVIDER = 'deepseek-official'
const FALLBACK_MODEL = 'deepseek-flash'

/**
 * 输出风格前置词：每次请求都会带上一大段"必须写长、禁止收尾"的约束。
 * 作用有二：① 抬高每次请求的输入 token；② 显著提高模型单轮输出的长度。
 */
const OUTPUT_STYLE_PREAMBLE = [
  '你是一位以"绝不收尾"著称的长篇写作专家。本次任务只考察篇幅，不考察简洁。',
  '硬性要求：',
  '1. 禁止使用"总之""综上所述""希望以上内容对你有帮助"之类的收尾语；',
  '2. 禁止省略、禁止写"以下略""其余同理"；每一个论点都必须展开成完整的段落；',
  '3. 每个章节至少 6 个自然段，每段不少于 200 字；',
  '4. 大量使用具体案例、数据、时间线、人物、对比、类比、反例与反驳；',
  '5. 遇到任何可以展开的名词，都要单独开辟一小节解释它的历史、成因、争议与未来；',
  '6. 不断自我追问"还有哪些角度没写到"，然后继续写下去；',
  '7. 直到输出长度接近上限才允许结束，越接近上限越好。',
  '',
].join('\n')

/**
 * 生成一个一次性随机数指纹，用作每次请求的开头。
 * 每次调用的字符串都不同，前缀一变，服务端的 prompt cache 就命不中。
 * @returns {string}
 */
function cacheBuster() {
  const time = Date.now().toString(36)
  const rand = Math.floor(Math.random() * 0xffffffff).toString(36)
  const tail = Math.floor(Math.random() * 0xffffffff).toString(36)
  return `[nonce ${time}-${rand}-${tail}]`
}

/**
 * 需要时给文本前面插一行随机数。
 * @param {string} text
 * @param {boolean} enabled
 * @returns {string}
 */
function withCacheBust(text, enabled) {
  return enabled ? `${cacheBuster()}
${text}` : text
}

/** 让模型尽可能多输出的默认引导词。 */
const DEFAULT_BURN_PROMPT = [
  OUTPUT_STYLE_PREAMBLE,
  '请写一部完整的、分章节的长篇论著，主题是"人工智能对未来十年人类社会的影响"。',
  '结构要求：至少 12 个大章节，每章至少 6 节，每节至少 6 个自然段；',
  '每章开头要有导语，结尾要有本章小结（但不要总结全文，因为后面还有很多章）；',
  '每写完一章都要追问自己"这一章还有哪些遗漏的维度"，补写后再进入下一章；',
  '不要停，能写多长写多长。',
].join('\n')

/**
 * 续写指令：第 2 轮及以后每轮都用一条新的、很长的"继续"指令，
 * 既保证话题不跑偏，又让每一轮的输入 token 稳定增加。
 * @param {number} round 0-based 轮次
 * @returns {string}
 */
function continuationPrompt(round) {
  return [
    OUTPUT_STYLE_PREAMBLE,
    `这是第 ${round + 1} 轮续写。上一轮的内容已经全部在上面，请紧接着往下写，不要复述、不要总结、不要重开话题。`,
    '本轮具体要求：',
    '· 先列出上一轮尚未展开的 5 个子话题，再逐一展开成小节；',
    '· 每个子话题至少给出 3 个真实或合理的案例，并对每个案例做正反两面的分析；',
    '· 补充历史脉络：这个子话题在过去 20 年里是如何演变的；',
    '· 补充争议：列出至少 3 种互相对立的观点，并逐一驳斥或辩护；',
    '· 补充预测：给出未来 5 年、10 年、20 年三个时间尺度的具体推断；',
    '· 依旧禁止任何形式的收尾，写完继续写下一个子话题。',
  ].join('\n')
}

/**
 * 从 agentDefaultModel 服务读当前默认 provider/model（会话当前选中的模型）；
 * 服务缺席时用兜底值。
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
function boundInt(label, value, fallback, max, tool = 'token_burn') {
  const n = value === undefined || value === null ? fallback : Number(value)
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${tool}: ${label} 必须是正整数，收到 ${JSON.stringify(value)}`)
  }
  if (n > max) {
    throw new Error(`${tool}: ${label} 超过上限 ${max}，收到 ${n}`)
  }
  return n
}

/**
 * 从流 chunk 里尽量稳健地取出增量文本。
 * 不同 provider 的 chunk 形状不一样（text / delta / textDelta / content.text），
 * 这里按常见字段逐个尝试，取不到就返回空串（不影响 usage 统计）。
 * @param {any} chunk
 * @returns {string}
 */
function chunkText(chunk) {
  if (chunk === null || typeof chunk !== 'object') {
    return typeof chunk === 'string' ? chunk : ''
  }
  const candidates = [
    chunk.text,
    chunk.delta,
    chunk.textDelta,
    chunk.content?.text,
    chunk.delta?.text,
    chunk.content,
    chunk.value,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return ''
}

/**
 * 把一条 usage chunk 读成标准结构。
 * @param {any} usage
 * @returns {{inputTokens:number, outputTokens:number, totalTokens:number}}
 */
function readUsage(usage) {
  const inputTokens = Number(usage?.inputTokens) || 0
  const outputTokens = Number(usage?.outputTokens) || 0
  const totalTokens = Number(usage?.totalTokens) || inputTokens + outputTokens
  return { inputTokens, outputTokens, totalTokens }
}

/**
 * 单个请求 = rounds 轮连续对话。
 *
 * 第 1 轮只发用户提示；之后每一轮都把「上一轮的完整输出」作为 assistant 消息、
 * 再追加一条很长的续写指令作为新的 user 消息。于是第 n 轮的输入 =
 * 前 n-1 轮的全部内容 + 新指令，输入 token 近似按轮数平方增长。
 *
 * @param {object} deps
 * @param {object} deps.llm
 * @param {{provider:string, model:string}} deps.route 会话默认路由
 * @param {number} deps.maxTokens
 * @param {string} deps.prompt
 * @param {number} deps.rounds
 * @param {AbortSignal} deps.signal
 * @returns {Promise<{inputTokens:number, outputTokens:number, totalTokens:number, ok:boolean, rounds:number, error?:string}>}
 */
async function runOneCall({ llm, route, maxTokens, prompt, rounds, signal, cacheBust = false }) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: withCacheBust(prompt, cacheBust) }] }]
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  let completedRounds = 0
  let lastError

  for (let round = 0; round < rounds; round += 1) {
    signal?.throwIfAborted()
    let text = ''
    let roundUsage = null
    try {
      for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        messages,
        maxTokens,
        signal,
      })) {
        signal?.throwIfAborted()
        const piece = chunkText(chunk)
        if (piece !== '') text += piece
        if (chunk?.type === 'usage' && chunk.usage) {
          roundUsage = readUsage(chunk.usage)
        }
      }
    } catch (error) {
      if (signal?.aborted) {
        return { ...usage, ok: false, rounds: completedRounds, error: 'aborted' }
      }
      lastError = error?.message ?? String(error)
      // 第 1 轮就失败 → 整个请求失败；后续轮失败 → 保留已消耗的部分，按部分成功算。
      if (completedRounds === 0) {
        return { ...usage, ok: false, rounds: 0, error: lastError }
      }
      break
    }

    if (roundUsage !== null) {
      usage.inputTokens += roundUsage.inputTokens
      usage.outputTokens += roundUsage.outputTokens
      usage.totalTokens += roundUsage.totalTokens
    }
    completedRounds += 1

    if (round + 1 < rounds) {
      // 把这一轮的输出原样回传给模型（拿不到文本时补一段占位，保证历史仍在变长）。
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: text !== '' ? text : '（上一轮输出未能取到，继续。）' }],
      })
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: withCacheBust(continuationPrompt(round), cacheBust) }],
      })
    }
  }

  return {
    ...usage,
    ok: completedRounds > 0,
    rounds: completedRounds,
    ...(lastError !== undefined ? { error: lastError } : {}),
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
    rounds: { type: 'integer' },
    succeeded: { type: 'integer' },
    failed: { type: 'integer' },
    partial: { type: 'integer' },
    inputTokens: { type: 'integer' },
    outputTokens: { type: 'integer' },
    totalTokens: { type: 'integer' },
    durationMs: { type: 'integer' },
    provider: { type: 'string' },
    model: { type: 'string' },
    cacheBust: { type: 'boolean' },
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
    `token_burn 完成：${value.succeeded}/${value.requests} 次成功，${value.failed} 次失败`
      + (value.partial > 0 ? `（其中 ${value.partial} 次中途截断）` : ''),
    `provider=${value.provider}  model=${value.model}`,
    `每个请求 ${value.rounds} 轮连续追问  并发=${value.concurrency}  耗时=${value.durationMs}ms`
      + (value.cacheBust ? '  缓存：每次请求前插随机数（低命中）' : ''),
    `input tokens=${value.inputTokens}  output tokens=${value.outputTokens}  total=${value.totalTokens}`,
  ]
  if (value.failures?.length > 0) {
    lines.push(`失败明细：${value.failures.join(' | ')}`)
  }
  return [{ type: 'text', text: lines.join('\\n') }]
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
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true, version: '2.2.0', route: resolveRoute(ctx) }))
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

/**
 * 把一条消息的 content 摊平成纯文本。
 * @param {any} message
 * @returns {string}
 */
function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (typeof part === 'string') parts.push(part)
    else if (part?.type === 'text' && typeof part.text === 'string') parts.push(part.text)
  }
  return parts.join('\n')
}

/**
 * 把消息数组转成「用户：… / 助手：…」的纯文本转录。
 * @param {any[]} messages
 * @returns {string}
 */
function transcriptFromMessages(messages) {
  const lines = []
  for (const message of messages ?? []) {
    if (message?.role !== 'user' && message?.role !== 'assistant') continue
    const text = messageText(message).trim()
    if (text !== '') lines.push(`${message.role === 'user' ? '用户' : '助手'}：${text}`)
  }
  return lines.join('\n\n')
}

/** 解析 DSH 数据根：$DSH_HOME 优先，其次 ~/.dsh。 */
function dshHome() {
  const configured = process.env.DSH_HOME?.trim()
  return configured ? resolve(configured) : join(homedir(), '.dsh')
}

/**
 * 从磁盘上的会话文件读转录（会话归档是 zstd 压缩的 jsonl）。
 * @param {string} sessionId
 * @returns {string|null}
 */
function transcriptFromDisk(sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  const root = join(dshHome(), 'sessions')
  if (!existsSync(root)) return null
  let dirs
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory())
  } catch {
    return null
  }
  for (const dir of dirs) {
    const base = join(root, dir.name, sessionId)
    if (!existsSync(base)) continue
    for (const file of ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl']) {
      const target = join(base, file)
      if (!existsSync(target)) continue
      try {
        const raw = readFileSync(target)
        const text = file.endsWith('.zstd')
          ? zstdDecompressSync(raw).toString('utf8')
          : raw.toString('utf8')
        const messages = []
        for (const line of text.split('\n')) {
          if (line.trim() === '') continue
          let record
          try { record = JSON.parse(line) } catch { continue }
          if (record?.role === 'user' || record?.role === 'assistant') messages.push(record)
          else if (record?.message?.role) messages.push(record.message)
        }
        const transcript = transcriptFromMessages(messages)
        if (transcript !== '') return transcript
      } catch {
        /* 损坏或未写完的文件，继续找下一个 */
      }
    }
  }
  return null
}

/**
 * 决定这一轮要检查的转录文本：显式 text > 内存里的会话消息 > 磁盘归档。
 * 超长时保留最近的部分。
 * @param {object} exec
 * @param {unknown} override
 * @param {number} maxChars
 * @returns {{text:string, source:string, truncated:boolean, totalChars:number}}
 */
function resolveTranscript(ctx, exec, override, maxChars) {
  let text = ''
  let source = ''
  if (typeof override === 'string' && override.trim() !== '') {
    text = override
    source = '参数 text'
  } else {
    const session = exec?.agent?.session
    const candidates = [
      ['当前会话内存', session?.messages],
      ['agent.messages', exec?.agent?.messages],
      ['agent.state.messages', exec?.agent?.state?.messages],
      ['会话服务', (() => {
        const id = session?.id
        if (typeof id !== 'string') return undefined
        try { return ctx?.get?.('agents')?.get?.(id)?.session?.messages } catch { return undefined }
      })()],
    ]
    for (const [label, messages] of candidates) {
      const live = transcriptFromMessages(messages)
      if (live !== '') {
        text = live
        source = label
        break
      }
    }
    if (text === '') {
      const disk = transcriptFromDisk(session?.id)
      if (disk !== null) {
        text = disk
        source = '会话归档文件'
      }
    }
  }
  if (text === '') {
    throw new Error('conversation_recheck: 读不到当前对话内容。请把要检查的对话文本通过 text 参数传入（这是最可靠的方式）')
  }
  const totalChars = text.length
  const truncated = totalChars > maxChars
  if (truncated) text = text.slice(totalChars - maxChars)
  return { text, source, truncated, totalChars }
}

/** 单次检查的提示词。 */
function buildCheckPrompt(transcript, cacheBust = false) {
  return [
    ...(cacheBust ? [cacheBuster(), ''] : []),
    '你是一名极其严格的对话审阅者。请检查下面这段对话：',
    '1) 有没有前后矛盾或自相矛盾的结论；',
    '2) 有没有事实性错误或无法验证的断言；',
    '3) 有没有用户提出但始终没有回答的问题。',
    '只输出一行，格式严格为：问题数=<整数>；结论=<不超过 20 字>',
    '',
    '对话如下：',
    '"""',
    transcript,
    '"""',
  ].join('\n')
}

/**
 * 跑一次检查：一次完整的 LLM 流式调用，取回结论文本和 usage。
 * @param {object} deps
 * @returns {Promise<{ok:boolean, verdict:string, inputTokens:number, outputTokens:number, totalTokens:number, error?:string}>}
 */
async function runOneCheck({ llm, route, transcript, maxTokens, signal, cacheBust = false }) {
  let text = ''
  let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  try {
    for await (const chunk of llm.stream({
      provider: route.provider,
      model: route.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: buildCheckPrompt(transcript, cacheBust) }] }],
      maxTokens,
      signal,
    })) {
      signal?.throwIfAborted()
      const piece = chunkText(chunk)
      if (piece !== '') text += piece
      if (chunk?.type === 'usage' && chunk.usage) usage = readUsage(chunk.usage)
    }
    return { ok: true, verdict: text.trim(), ...usage }
  } catch (error) {
    if (signal?.aborted) return { ok: false, verdict: '', ...usage, error: 'aborted' }
    return { ok: false, verdict: '', ...usage, error: error?.message ?? String(error) }
  }
}

/** conversation_recheck 的输出 schema。 */
const RECHECK_SCHEMA = {
  type: 'object',
  properties: {
    times: { type: 'integer' },
    concurrency: { type: 'integer' },
    succeeded: { type: 'integer' },
    failed: { type: 'integer' },
    dryRun: { type: 'boolean' },
    transcriptChars: { type: 'integer' },
    transcriptSource: { type: 'string' },
    truncated: { type: 'boolean' },
    inputTokens: { type: 'integer' },
    outputTokens: { type: 'integer' },
    totalTokens: { type: 'integer' },
    durationMs: { type: 'integer' },
    provider: { type: 'string' },
    model: { type: 'string' },
    cacheBust: { type: 'boolean' },
    samples: { type: 'array', items: { type: 'string' } },
    failures: { type: 'array', items: { type: 'string' } },
  },
}

/**
 * 把检查结果渲染成文本。
 * @param {unknown} _args
 * @param {object} value
 * @returns {{type:'text', text:string}[]}
 */
function renderRecheck(_args, value) {
  if (value.dryRun) {
    return [{
      type: 'text',
      text: `conversation_recheck 预演：${value.times} 遍 × ${value.transcriptChars} 字（约 ${Math.ceil(value.transcriptChars * 0.6)} token/遍）\n`
        + `预计输入 ${Math.ceil(value.transcriptChars * 0.6) * value.times} token 左右，未发起任何调用。`,
    }]
  }
  const lines = [
    `conversation_recheck 完成：${value.succeeded}/${value.times} 次成功，${value.failed} 次失败`,
    `provider=${value.provider}  model=${value.model}`,
    `每遍 ${value.transcriptChars} 字（来源：${value.transcriptSource}${value.truncated ? '，已截断' : ''}）  并发=${value.concurrency}  耗时=${value.durationMs}ms`
      + (value.cacheBust ? '  缓存：每遍插随机数（低命中）' : ''),
    `input tokens=${value.inputTokens}  output tokens=${value.outputTokens}  total=${value.totalTokens}`,
  ]
  if (value.samples?.length > 0) lines.push(`抽样结论：${value.samples.join(' | ')}`)
  if (value.failures?.length > 0) lines.push(`失败明细：${value.failures.join(' | ')}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

export function apply(ctx, config) {
  const cfg = {
    defaultConcurrency: 8,
    defaultRequests: 16,
    defaultMaxTokens: 16384,
    defaultRounds: 3,
    maxConcurrency: 64,
    maxRequests: 512,
    maxRounds: 16,
    defaultRecheckTimes: 1000,
    maxRecheckTimes: 10000,
    recheckConcurrency: 8,
    maxRecheckConcurrency: 32,
    cacheBust: true,
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
      + '一次发起 requests 个真实的模型生成请求，按 concurrency 并发度同时跑；'
      + '每个请求内部连续追问 rounds 轮，历史全量回传，输入 token 随轮数近似平方增长、'
      + '输出 token 随轮数线性增长，因此同样请求数下消耗远高于单轮调用。'
      + '使用的模型与当前会话一致（跟随会话默认模型），不会自行切换。'
      + '返回本次消耗的 input/output/total token 与成功率。'
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
          description: `每一轮的最大输出 token 数（默认 ${cfg.defaultMaxTokens}）。越大单轮输出越长。`,
        },
        rounds: {
          type: 'integer',
          description:
            `每个请求连续追问的轮数（默认 ${cfg.defaultRounds}，上限 ${cfg.maxRounds}）。`
            + '轮数越高消耗越大：第 n 轮的输入包含前面所有轮次的完整内容。',
        },
        prompt: {
          type: 'string',
          description: '可选：每个请求要模型生成的文本主题。缺省用内置的"长文论述"引导词。',
        },
        cacheBust: {
          type: 'boolean',
          description: '可选：每次请求前插入一个新的随机数，让服务端 prompt cache 命不中（默认 true）。',
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
      const rounds = boundInt('rounds', args?.rounds, cfg.defaultRounds, cfg.maxRounds)
      const prompt = typeof args?.prompt === 'string' && args.prompt.trim() !== ''
        ? args.prompt
        : DEFAULT_BURN_PROMPT
      const cacheBust = args?.cacheBust === undefined ? cfg.cacheBust !== false : args.cacheBust === true
      const route = resolveRoute(ctx)

      exec.signal?.throwIfAborted()
      const startedAt = Date.now()

      const results = await runPool(requests, concurrency, () =>
        runOneCall({
          llm: ctx.llm,
          route,
          maxTokens,
          prompt,
          rounds,
          cacheBust,
          signal: exec.signal,
        }),
      )

      const succeeded = results.filter((r) => r.ok && (r.error === undefined)).length
      const partial = results.filter((r) => r.ok && r.error !== undefined).length
      const failed = results.filter((r) => !r.ok).length
      const sum = (key) => results.reduce((acc, r) => acc + (Number(r[key]) || 0), 0)
      const failures = results
        .filter((r) => r.error && !(r.ok && r.rounds > 0))
        .map((r) => r.error)
        .slice(0, 20)

      return {
        requests,
        concurrency,
        rounds,
        succeeded,
        failed,
        partial,
        inputTokens: sum('inputTokens'),
        outputTokens: sum('outputTokens'),
        totalTokens: sum('totalTokens'),
        durationMs: Date.now() - startedAt,
        provider: route.provider,
        model: route.model,
        cacheBust,
        failures,
      }
    },
  })

  ctx.tools.register({
    name: 'conversation_recheck',
    description:
      '把当前对话（或你传入的文本）反复交给模型审阅 N 遍，默认 1000 遍，可调到 10000 遍。'
      + '每一遍都是一次真实的模型调用：整段对话作为输入，模型只回一行检查结论。'
      + '返回成功/失败次数、累计 input/output/total token、抽样结论。'
      + '用于压测长上下文、观察「同一段对话被读了 1000 遍」到底花多少钱。'
      + '先传 dryRun=true 可以只看预估 token，不发起任何调用。'
      + '注意：这会真实消耗账号额度，1000 遍的输入量是单次对话的上千倍。',
    parameters: {
      type: 'object',
      properties: {
        times: {
          type: 'integer',
          description: `检查遍数（默认 ${cfg.defaultRecheckTimes}，上限 ${cfg.maxRecheckTimes}）。`,
        },
        concurrency: {
          type: 'integer',
          description: `并发度（默认 ${cfg.recheckConcurrency}，上限 ${cfg.maxRecheckConcurrency}）。`,
        },
        maxTokens: {
          type: 'integer',
          description: '每一遍最多让模型输出多少 token（默认 64，只够回一行结论）。',
        },
        maxChars: {
          type: 'integer',
          description: '对话最多取多少字符（默认 8000，超长会保留最近的部分）。',
        },
        text: {
          type: 'string',
          description: '可选：手动指定要检查的文本；不传则自动读当前会话的对话内容。',
        },
        dryRun: {
          type: 'boolean',
          description: '可选：true 只返回预估 token，不发起任何模型调用。',
        },
        cacheBust: {
          type: 'boolean',
          description: '可选：每遍检查前插入一个新的随机数，让 prompt cache 命不中（默认 true）。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: RECHECK_SCHEMA,
      render: renderRecheck,
    },
    async execute(args, exec) {
      const times = boundInt('times', args?.times, cfg.defaultRecheckTimes, cfg.maxRecheckTimes, 'conversation_recheck')
      const concurrency = boundInt('concurrency', args?.concurrency, cfg.recheckConcurrency, cfg.maxRecheckConcurrency, 'conversation_recheck')
      const maxTokens = boundInt('maxTokens', args?.maxTokens, 64, 4096, 'conversation_recheck')
      const maxChars = boundInt('maxChars', args?.maxChars, 8000, 200_000, 'conversation_recheck')
      const transcript = resolveTranscript(ctx, exec, args?.text, maxChars)
      const cacheBust = args?.cacheBust === undefined ? cfg.cacheBust !== false : args.cacheBust === true
      const route = resolveRoute(ctx)

      if (args?.dryRun === true) {
        return {
          times,
          concurrency,
          succeeded: 0,
          failed: 0,
          dryRun: true,
          transcriptChars: transcript.text.length,
          transcriptSource: transcript.source,
          truncated: transcript.truncated,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          durationMs: 0,
          provider: route.provider,
          model: route.model,
          samples: [],
          failures: [],
        }
      }

      exec.signal?.throwIfAborted()
      const startedAt = Date.now()
      const results = await runPool(times, concurrency, () =>
        runOneCheck({
          llm: ctx.llm,
          route,
          transcript: transcript.text,
          maxTokens,
          cacheBust,
          signal: exec.signal,
        }),
      )

      const succeeded = results.filter(r => r.ok).length
      const failed = results.length - succeeded
      const sum = key => results.reduce((acc, r) => acc + (Number(r[key]) || 0), 0)
      const samples = []
      for (const r of results) {
        if (!r.ok || r.verdict === '') continue
        const line = r.verdict.split('\n')[0].slice(0, 60)
        if (line !== '' && !samples.includes(line)) samples.push(line)
        if (samples.length >= 3) break
      }
      const failures = results.filter(r => !r.ok && r.error).map(r => r.error).slice(0, 20)

      return {
        times,
        concurrency,
        succeeded,
        failed,
        dryRun: false,
        transcriptChars: transcript.text.length,
        transcriptSource: transcript.source,
        truncated: transcript.truncated,
        inputTokens: sum('inputTokens'),
        outputTokens: sum('outputTokens'),
        totalTokens: sum('totalTokens'),
        durationMs: Date.now() - startedAt,
        provider: route.provider,
        model: route.model,
        cacheBust,
        samples,
        failures,
      }
    },
  })
}
