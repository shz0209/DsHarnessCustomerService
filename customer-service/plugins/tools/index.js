/**
 * Customer Service tools: the tools a Customer-facing agent may see or call,
 * and the blocking order card `search_orders` presents.
 *
 * Every tool is registered globally and then masked down to
 * {@link ALLOWED_TOOLS} on every agent scope, which is also declared native
 * there (ADR-0005: the restriction, the guard, the prompt filter, and the
 * presentation together are the mask). The mask is a hardcoded security
 * invariant — no config field turns it off — so the model can neither see nor
 * call the harness's own tools, a preset's delegation tools included, even
 * though all of them are registered in the same process.
 *
 * `search_orders` blocks until the Customer answers on the card. The candidates
 * cannot ride the session journal (an out-of-tree plugin cannot mint a session
 * event), so the card reads them from the `order-question` route and posts the
 * answer back; the tool's return value is the Order the Customer picked, which
 * keeps "model-visible ⟺ logged" true for free (ADR-0001).
 *
 * 人工还宝 and 退款 each arrive as two tools rather than one: 校验 decides and
 * issues the grant, the action spends it (ADR-0002). They are built in
 * `manual-return.js` and `refund.js` and published here with everything else,
 * so one allowlist governs them all.
 */
import { createGrants } from '../shared/grants.js'
import { readJsonBody, registerJsonRoute, sendJson } from '../shared/http.js'
import { ORDER_SCHEMA, orderLine, publicOrder } from '../shared/orders.js'
import { DEMO_ZONE_OFFSET, inDemoZone } from '../shared/time.js'
import { ORDER_STATUS_LABELS } from '../shared/vocabulary.js'
import { MANUAL_RETURN_TOOLS, manualReturnTools } from './manual-return.js'
import { REFUND_TOOLS, refundTools } from './refund.js'

/** Cordis plugin name. */
export const name = 'customer-service-tools'

/** Required services: the Tool registry and its Agent registry, the login
 * binding, the Order table, and the HTTP router behind the trust fence. */
export const inject = ['tools', 'agents', 'customerIdentity', 'customerStore', 'webServer', 'connection']

/** The tool that queries Orders, and the name the opening protocol calls it by.
 * The browser's Card is keyed by the same name but cannot import it — a rename
 * has to reach `plugins/ui/client.js` by hand (ADR-0006). */
export const SEARCH_ORDERS_TOOL = 'search_orders'

/** The only tools any agent of this deployment may see or call: querying an
 * Order, and one 校验 + action pair per service action — 人工还宝 and 退款. */
export const ALLOWED_TOOLS = [SEARCH_ORDERS_TOOL, ...MANUAL_RETURN_TOOLS, ...REFUND_TOOLS]

/** Argument names `search_orders` accepts. Anything else is rejected, not ignored. */
const PARAMETER_NAMES = ['location', 'rentedFrom', 'rentedTo']

/** What `search_orders` returns: the picked Order, or why there is none. */
const OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['outcome', 'order'],
      properties: {
        outcome: { type: 'string', const: 'selected' },
        order: ORDER_SCHEMA,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['outcome'],
      properties: {
        outcome: { type: 'string', enum: ['declined', 'none'] },
      },
    },
  ],
}

/**
 * The candidates the card renders, each with the Chinese status label so the
 * browser needs no copy of the status vocabulary.
 * @param order - the stored Order row.
 * @returns the card's view of one candidate Order.
 */
function candidateOrder(order) {
  return { ...publicOrder(order), statusLabel: ORDER_STATUS_LABELS[order.status] }
}

/**
 * Validate and normalize the model's arguments into a store filter.
 *
 * Validation belongs here, at the model boundary: the store receives a filter
 * it can compare directly. Every bound comes back as an ISO-8601 instant in
 * {@link DEMO_ZONE_OFFSET}, so "9月21日" covers that whole Beijing day.
 * @param args - the parsed arguments from the model.
 * @returns `location` (a trimmed substring) and inclusive ISO-8601 instants,
 *   each present only when the model supplied it.
 * @throws {TypeError} with the message the model reads, when an argument is
 *   present but unusable, or when the range is inverted.
 */
function parseFilter(args) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new TypeError(`参数必须是一个对象，可用的字段：${PARAMETER_NAMES.join('、')}。`)
  }
  const unknown = Object.keys(args).filter(key => !PARAMETER_NAMES.includes(key))
  if (unknown.length > 0) {
    throw new TypeError(`未知参数：${unknown.join('、')}。本工具只接受 ${PARAMETER_NAMES.join('、')}，没有客户参数——身份来自当前登录。`)
  }

  const filter = {}
  if (args.location !== undefined) {
    if (typeof args.location !== 'string' || args.location.trim() === '') {
      throw new TypeError('location 必须是非空字符串，例如「万象城」。')
    }
    filter.location = args.location.trim()
  }
  if (args.rentedFrom !== undefined) filter.rentedFrom = parseInstant(args.rentedFrom, 'rentedFrom', '00:00:00.000')
  if (args.rentedTo !== undefined) filter.rentedTo = parseInstant(args.rentedTo, 'rentedTo', '23:59:59.999')
  if (filter.rentedFrom !== undefined && filter.rentedTo !== undefined
    && Date.parse(filter.rentedFrom) > Date.parse(filter.rentedTo)) {
    throw new TypeError('时间范围的开始晚于结束，请调整 rentedFrom 与 rentedTo。')
  }
  return filter
}

/**
 * Normalize one time bound to a full ISO-8601 instant in this deployment's zone.
 * @param value - the model's value: a date, a date-time, or either with an offset.
 * @param field - the argument name, for the error message.
 * @param endOfDay - the clock time a date-only value expands to.
 * @returns the instant as ISO-8601 carrying {@link DEMO_ZONE_OFFSET}.
 * @throws {TypeError} when the value is not a string, or names no real instant.
 */
function parseInstant(value, field, endOfDay) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} 必须是 ISO-8601 时间字符串，例如 2026-09-21 或 2026-09-21T08:05:00+08:00。`)
  }
  const trimmed = value.trim()
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
  const instant = Date.parse(dateOnly
    ? `${trimmed}T${endOfDay}${DEMO_ZONE_OFFSET}`
    : qualify(trimmed))
  if (!Number.isFinite(instant)) {
    throw new TypeError(`${field} 无法识别为时间：${trimmed}。请用 ISO-8601，例如 2026-09-21T08:05:00+08:00。`)
  }
  return inDemoZone(instant)
}

/**
 * Give an unqualified date-time this deployment's zone. A value that already
 * names one keeps it: the model may be told to read a time in another zone, and
 * that reading is not this function's to overrule.
 * @param value - a date-time the model supplied.
 * @returns the date-time with an explicit offset.
 */
function qualify(value) {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}${DEMO_ZONE_OFFSET}`
}

/** Prefix every tool's guidance section is registered under. */
const TOOL_SECTION_PREFIX = 'tool:'

/**
 * Whether a prompt section belongs to a tool the allowlist excludes.
 *
 * Tool guidance sections are named `tool:<toolName>` throughout the harness
 * (`tool:bash`, `tool:subagent`, …), so the same key the model's tool list is
 * filtered by decides this too. A section named anything else is left alone.
 * @param name - the section name as registered.
 * @returns whether the section is one hidden tool's own guidance.
 */
function namesHiddenTool(name) {
  return name.startsWith(TOOL_SECTION_PREFIX)
    && !ALLOWED_TOOLS.includes(name.slice(TOOL_SECTION_PREFIX.length))
}

/**
 * Mask every agent down to {@link ALLOWED_TOOLS} and publish the tools, their
 * routes, and the pending-question table.
 * @param ctx - plugin context carrying the Tool registry, the Agent registry,
 *   the login binding, the Order table, and the HTTP router.
 */
export function apply(ctx) {
  /** Pending order questions by tool call id, each awaiting one Customer answer. */
  const pending = new Map()

  /** The one tool a Customer-facing agent may call. */
  const definition = {
    name: SEARCH_ORDERS_TOOL,
    description: [
      '在当前客户自己的订单中查询，并请客户确认要咨询的是哪一笔。',
      '查到订单后会把订单卡片推给客户，等客户作答后才返回，所以本工具可能会等待较久。',
      '返回值是客户确认的那一笔订单；客户说都不是时返回 declined；一笔都没查到时返回 none，此时应请客户补充大概的时间或地点再查。',
      '可选参数：location（租借地点，按包含匹配）、rentedFrom / rentedTo（租借时间范围，含端点）。时间按北京时间（UTC+8）解释：只写日期（2026-10-09）表示那一整天的北京时间，也可写完整的带偏移时间（2026-10-09T18:40:00+08:00）。两者都不给时查的是时间最近的一笔，卡片只问客户「是不是这一笔」；给了任一参数则按条件过滤，命中多笔时卡片会逐条列出供客户挑选。',
      '本工具没有客户参数：客户身份来自当前登录，永远查不到别人的订单。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        location: { type: 'string', description: '租借地点，模糊匹配（包含即可）。可选。' },
        rentedFrom: { type: 'string', description: '租借时间范围的开始（含）。只写日期表示那一天的北京时间 00:00。可选。' },
        rentedTo: { type: 'string', description: '租借时间范围的结束（含）。只写日期表示那一天的北京时间 23:59:59。可选。' },
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        switch (value.outcome) {
          case 'none':
            return [{ type: 'text', text: '没有查到符合条件的订单。' }]
          case 'declined':
            return [{ type: 'text', text: '客户表示这次查到的订单都不是要咨询的那一笔。' }]
          default:
            return [{ type: 'text', text: `客户确认的订单：${orderLine(value.order)}` }]
        }
      },
      // The card renders the chosen Order from the settled call, so the
      // persisted metadata carries the Chinese status label the model-facing
      // value has no room for (its schema is closed).
      presentationMeta: (_args, value) => value.outcome === 'selected'
        ? { ...value, order: { ...value.order, statusLabel: ORDER_STATUS_LABELS[value.order.status] } }
        : value,
    },
    async execute(args, exec) {
      const filter = parseFilter(args)
      const agent = exec.agent
      if (agent === undefined) throw new Error('订单查询必须在一个客户会话中进行。')
      const customer = ctx.customerIdentity.forSession(agent.session.id)
      if (customer === undefined) throw new Error('当前会话没有绑定客户，无法查询订单，请先登录。')

      const matches = ctx.customerStore.searchOrders(customer.customerId, filter)
      if (matches.length === 0) return { outcome: 'none' }

      // A query with neither bound asks nothing in particular, and the contract
      // for it is one Order — the newest — put to the Customer as a yes/no Card
      // (ADR-0001). A narrowed query is the one that lists what it matched.
      const offered = Object.keys(filter).length === 0 ? matches.slice(0, 1) : matches

      const answer = await askCustomer(pending, {
        callId: exec.callId,
        sessionId: agent.session.id,
        query: filter,
        candidates: offered.map(candidateOrder),
        signal: exec.signal,
      })
      if (answer.kind === 'cancelled') throw new Error('订单确认已取消：客户没有作答。')
      if (answer.orderId === null) return { outcome: 'declined' }
      return { outcome: 'selected', order: publicOrder(offered.find(order => order.orderId === answer.orderId)) }
    },
  }

  ctx.effect(() => ctx.tools.register(definition), 'customer-service-tools: search_orders')

  // 校验 grants live here, in the process that runs both halves of every action
  // that spends one (ADR-0002; ADR-0009 on why they are not persisted).
  const grants = createGrants()
  for (const tool of [...manualReturnTools(ctx, grants), ...refundTools(ctx, grants)]) {
    ctx.effect(() => ctx.tools.register(tool), `customer-service-tools: ${tool.name}`)
  }

  registerJsonRoute(ctx, { label: name, path: '/order-question', method: 'GET', handler: readQuestion(ctx, pending) })
  registerJsonRoute(ctx, { label: name, path: '/order-question/answer', method: 'POST', handler: answerQuestion(ctx, pending) })

  // Every Agent of this deployment is a Customer-facing one: the caller is
  // always the model the Customer is chatting with. The mask therefore goes on
  // every live Agent and every later one, not on a chosen subset. Four
  // declarations are what it takes to reach every tool — one per kind of tool
  // the registry holds, since no single mechanism covers all of them; the
  // measurements behind each are in ADR-0005.
  const restricted = new Map()
  const restrict = agent => {
    if (restricted.has(agent)) return
    const scoped = agent.ctx
    restricted.set(agent, [
      scoped.tools.restrict({ allow: ALLOWED_TOOLS }),
      scoped.tools.presentAs('native'),
      // A name the view still resolves is one `restrict` could not reach, so it
      // is denied here rather than left callable. A name the view does NOT
      // resolve abstains, leaving the registry to raise its own failure with
      // its own code. The denial repeats the registry's wording on purpose:
      // what an agent cannot reach must be indistinguishable from what does
      // not exist, or the mask leaks the shape of the registry behind it.
      scoped.tools.guard(exec => scoped.tools.get(exec.name, exec.agent) === undefined
        || ALLOWED_TOOLS.includes(exec.name)
        ? undefined
        : `unknown tool "${exec.name}"`),
      // The model reads its tool list from the assembled prompt, so hiding the
      // own-layer residue means filtering the assembly, not the registry view.
      // Tool guidance is dropped with it: a hidden tool's instructions would
      // otherwise tell the model to reach for a tool it cannot call. Prepended
      // so the filter runs last and no later listener can widen the list back.
      scoped.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const assembly = await next()
        return {
          ...assembly,
          tools: assembly.tools.filter(tool => ALLOWED_TOOLS.includes(tool.name)),
          sections: assembly.sections.filter(section => !namesHiddenTool(section.name)),
        }
      }, { prepend: true }),
    ])
  }
  for (const agent of ctx.agents.list()) restrict(agent)
  ctx.on('agent/created', ({ agent }) => { restrict(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    for (const dispose of restricted.get(agent) ?? []) dispose()
    restricted.delete(agent)
  })
  ctx.effect(() => () => {
    for (const disposers of restricted.values()) for (const dispose of disposers) dispose()
    restricted.clear()
  }, 'customer-service-tools: tool allowlist')
}

/**
 * The key one pending question is filed under.
 *
 * A model-supplied tool call id is unique within its own Session, not across
 * the process: two Customers' models can both emit `call_1`. Keying by the call
 * alone would let the second question evict the first, so the Session that may
 * answer it is part of the key — which also makes the ownership check a lookup
 * rather than a comparison after one.
 * @param sessionId - the Session whose Agent asked.
 * @param callId - the tool call the card belongs to.
 * @returns the pending-table key.
 */
function pendingKey(sessionId, callId) {
  return `${sessionId}\n${callId}`
}

/**
 * Publish one order question and block until the Customer answers it or the
 * calling turn is cancelled.
 * @param pending - the live pending questions, keyed by Session and call id.
 * @param question - the call identity, the login Session that may answer it,
 *   the query to echo, the candidate Orders, and the turn's cancellation.
 * @returns the answer: the chosen `orderId` (`null` for "none of these"), or a
 *   cancellation.
 */
async function askCustomer(pending, question) {
  const key = pendingKey(question.sessionId, question.callId)
  const settled = Promise.withResolvers()
  pending.set(key, {
    query: question.query,
    candidates: question.candidates,
    answer(orderId) {
      if (!pending.delete(key)) return
      settled.resolve({ kind: 'answered', orderId })
    },
  })
  // The turn can be cancelled before the Customer ever answers — the browser
  // tab closes, or the model stops. Neither is an answer, and neither may
  // leave the card looking answerable.
  const cancel = () => {
    if (!pending.delete(key)) return
    settled.resolve({ kind: 'cancelled' })
  }
  question.signal.addEventListener('abort', cancel, { once: true })
  if (question.signal.aborted) cancel()
  try {
    return await settled.promise
  } finally {
    question.signal.removeEventListener('abort', cancel)
    pending.delete(key)
  }
}

/**
 * Build the handler that serves one pending order question to the card.
 * @param ctx - plugin context carrying the login binding.
 * @param pending - the live pending questions, keyed by Session and call id.
 * @returns the route handler.
 */
function readQuestion(ctx, pending) {
  return (req, res) => {
    const login = ctx.customerIdentity.forRequest(req)
    if (login === undefined) {
      sendJson(res, 401, { error: '请先登录' })
      return
    }
    const callId = new URL(req.url ?? '/', 'http://x').searchParams.get('callId')
    // Another Session's question is not found rather than forbidden: the card
    // is not a resource a Customer may learn exists.
    const entry = callId === null ? undefined : pending.get(pendingKey(login.sessionId, callId))
    if (entry === undefined) {
      sendJson(res, 404, { error: '没有等待作答的订单卡片' })
      return
    }
    sendJson(res, 200, { query: entry.query, candidates: entry.candidates })
  }
}

/**
 * Build the handler that carries the Customer's answer back to the blocked
 * tool call.
 * @param ctx - plugin context carrying the login binding.
 * @param pending - the live pending questions, keyed by Session and call id.
 * @returns the route handler.
 */
function answerQuestion(ctx, pending) {
  return async (req, res) => {
    const login = ctx.customerIdentity.forRequest(req)
    if (login === undefined) {
      sendJson(res, 401, { error: '请先登录' })
      return
    }
    const body = await readJsonBody(req)
    if (body === undefined || typeof body.callId !== 'string'
      || !(body.orderId === null || typeof body.orderId === 'string')) {
      sendJson(res, 400, { error: '请求格式不正确' })
      return
    }
    const entry = pending.get(pendingKey(login.sessionId, body.callId))
    if (entry === undefined) {
      sendJson(res, 404, { error: '这张订单卡片已经失效' })
      return
    }
    if (body.orderId !== null && !entry.candidates.some(candidate => candidate.orderId === body.orderId)) {
      sendJson(res, 400, { error: '这个订单不在本次查询结果中' })
      return
    }
    entry.answer(body.orderId)
    sendJson(res, 200, { ok: true })
  }
}
