/**
 * Customer Service auth: the login and logout routes, the harness-session ↔
 * Customer binding, the opening that starts the conversation, and the identity
 * the model is told about.
 *
 * The binding lives in this process only. It is set when a login succeeds and
 * dropped on logout, so a restart requires logging in again — acceptable for a
 * demo, and the reason no binding table exists in the store. Tools resolve the
 * Customer through `customerIdentity`, never through a tool argument (ADR-0004).
 *
 * The opening is a login event with two halves that have to agree: this plugin
 * delivers one trigger message per Session (`POST /opening`, asked for by the
 * browser), and it tells the model what that message means. The message is the
 * deployment's own — a user-role message carrying this plugin's source kind, so
 * the conversation shows a system trigger row rather than a bubble in the
 * Customer's voice — which keeps the greeting, the card it pushes, and the
 * answer to it readable from the session log (ADR-0008).
 *
 * Every client-facing call is a bare HTTP route, not a remote method: a remote
 * method cannot read the login cookie, and the browser half is hand-written
 * outside the code-generation path (ADR-0003).
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { SEARCH_ORDERS_TOOL } from '../tools/index.js'
import { readJsonBody, registerJsonRoute, requireLogin, sendJson } from '../shared/http.js'
import { TIER_LABELS } from '../shared/vocabulary.js'

/** Cordis plugin name. */
export const name = 'customer-service-auth'

/** Required services: the HTTP router, the request-trust fence, Session
 * creation and prompt admission, the prompt-context registry, the Workspace
 * registry, and the Customer table. */
export const inject = [
  'webServer', 'connection', 'sessionController', 'systemPrompt', 'workspaceRegistry', 'customerStore',
]

/** Cookie carrying the login. Opaque; it never contains a Customer id. */
const COOKIE_NAME = 'cs_session'

/** Prompt-context position. Sorted after the shipped delegation context (120). */
const IDENTITY_CONTEXT_ORDER = 130

/** Prompt-context position of the opening protocol, after the identity line. */
const OPENING_CONTEXT_ORDER = 140

/** The one message a failed login shows. It names neither field, on purpose. */
const CREDENTIALS_ERROR = '账号或密码错误'

/**
 * The trigger message the host delivers when a Customer logs in, and the one
 * the opening protocol tells the model to read as "the Customer is sitting
 * down". Nothing the Customer typed, so nothing is expected of them before the
 * Agent speaks.
 */
const OPENING_MESSAGE = '你好'

/**
 * The source kind the trigger is recorded under. Not `user`, so the
 * conversation renders it as the non-human trigger row (the harness names such
 * input by its source kind) instead of putting words in the Customer's mouth.
 */
const OPENING_SOURCE_KIND = 'customer-service'

/** What the route answers when the harness would not admit the opening. */
const OPENING_ERROR = '开场消息发送失败，请刷新页面重试'

/**
 * Register the routes, publish `customerIdentity`, and contribute the identity
 * and the opening protocol to every model request in a bound Session.
 *
 * The login Session is created inside `config.workspacePath`'s Workspace. A
 * Session created without one carries a working directory but belongs to no
 * Workspace, and the client renders that as the "choose a workspace" landing
 * instead of the conversation — the Customer would then chat in a Session the
 * login never bound, and the model would be told nothing about them.
 * @param ctx - plugin context carrying the injected services.
 * @param config - plugin config; `workspacePath` is the demo Workspace directory.
 */
export function apply(ctx, config) {
  const workspacePath = config?.workspacePath
  if (typeof workspacePath !== 'string' || !isAbsolute(workspacePath)) {
    throw new TypeError('customer-service-auth: config.workspacePath must be an absolute directory path')
  }

  /** Session id → Customer id, set at login and dropped at logout. */
  const boundCustomers = new Map()
  /** Login token (the cookie value) → Session id. */
  const sessionsByToken = new Map()
  /** Session id → the browser zone its opening carried (`null` when the browser
   * named none): one greeting per login, and the zone the opening protocol
   * states, both dropped with the binding they belong to. */
  const openings = new Map()

  ctx.provide('customerIdentity', {
    /**
     * Resolve the Customer bound to a harness Session.
     * @param sessionId - the Session id the caller is operating in.
     * @returns the Customer row, or `undefined` when nothing is bound.
     */
    forSession(sessionId) {
      return customerById(ctx, boundCustomers, sessionId)
    },

    /**
     * Resolve the Customer a browser request is logged in as.
     *
     * This is the only identity a client-facing route may trust: the cookie is
     * `HttpOnly`, so no request the model can compose carries a Customer id.
     * @param req - the incoming request.
     * @returns the login Session id and its Customer row, or `undefined` when
     *   the request carries no live login.
     */
    forRequest(req) {
      const token = readCookie(req, COOKIE_NAME)
      const sessionId = token === undefined ? undefined : sessionsByToken.get(token)
      if (sessionId === undefined) return undefined
      const customer = customerById(ctx, boundCustomers, sessionId)
      return customer === undefined ? undefined : { sessionId, customer }
    },
  })

  ctx.systemPrompt.context({
    name: 'customer-service:identity',
    order: IDENTITY_CONTEXT_ORDER,
    required: true,
    interpolate: false,
    text: context => identityText(ctx, boundCustomers, context),
  })

  ctx.systemPrompt.context({
    name: 'customer-service:opening',
    order: OPENING_CONTEXT_ORDER,
    required: true,
    interpolate: false,
    text: context => openingText(ctx, boundCustomers, openings, context),
  })

  /**
   * Answer the current login state from the login cookie.
   * @param req - the incoming request.
   * @param res - the response to write.
   */
  const current = (req, res) => {
    const login = ctx.customerIdentity.forRequest(req)
    if (login === undefined) {
      sendJson(res, 200, { loggedIn: false })
      return
    }
    sendJson(res, 200, { loggedIn: true, ...publicCustomer(login.customer), sessionId: login.sessionId })
  }

  /**
   * The demo credentials, for the login page's small print.
   * @param req - the incoming request.
   * @param res - the response to write.
   */
  const demoAccounts = (req, res) => {
    const accounts = ctx.customerStore.demoAccounts()
      .map(account => ({ ...account, tierLabel: TIER_LABELS[account.tier] }))
    sendJson(res, 200, { accounts })
  }

  /**
   * Verify credentials, open a new Session, bind it, and set the login cookie.
   * @param req - the incoming request.
   * @param res - the response to write.
   */
  const login = async (req, res) => {
    const body = await readJsonBody(req)
    if (body === undefined || typeof body.accountName !== 'string' || typeof body.password !== 'string') {
      sendJson(res, 400, { error: '请求格式不正确' })
      return
    }
    const customer = ctx.customerStore.authenticate(body.accountName, body.password)
    if (customer === undefined) {
      sendJson(res, 401, { error: CREDENTIALS_ERROR })
      return
    }
    // `create(path)` returns the Workspace already registered for that
    // directory, so repeat logins reuse one registration.
    const workspace = await ctx.workspaceRegistry.create(workspacePath)
    const { sessionId } = await ctx.sessionController.create({ workspaceId: workspace.id })
    const token = randomBytes(32).toString('base64url')
    boundCustomers.set(sessionId, customer.customerId)
    sessionsByToken.set(token, sessionId)
    // No `Max-Age`: this is a session cookie, so closing the browser logs the
    // Customer out. The demo does not offer "remember me".
    res.setHeader('set-cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict`)
    sendJson(res, 200, { ...publicCustomer(customer), sessionId })
  }

  /**
   * Drop the binding and clear the login cookie.
   * @param req - the incoming request.
   * @param res - the response to write.
   */
  const logout = (req, res) => {
    const token = readCookie(req, COOKIE_NAME)
    if (token !== undefined) {
      const sessionId = sessionsByToken.get(token)
      sessionsByToken.delete(token)
      // Only drop the binding for the Session this cookie owned.
      if (sessionId !== undefined) {
        boundCustomers.delete(sessionId)
        openings.delete(sessionId)
      }
    }
    res.setHeader('set-cookie', `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`)
    sendJson(res, 200, { ok: true })
  }

  /**
   * Deliver the opening message to the Session the login bound.
   *
   * The browser asks for this once per page load, as soon as it knows which
   * Session it is in; only the first ask is delivered. The trigger is not
   * something the Customer said, so it is not sent as one: the message carries
   * this deployment's own source kind, and the conversation shows it as the
   * non-human trigger row the harness renders for such input, not as a bubble
   * in the Customer's voice (ADR-0008).
   *
   * The browser's time zone cannot ride this message — the harness derives it
   * only from messages the browser sent — so it is kept here and stated in the
   * opening protocol instead: without it the model would be told to ask the
   * Customer which zone their times are in. A zone the harness would refuse is
   * dropped rather than failing the greeting, and a malformed body is refused
   * outright.
   * @param req - the incoming request.
   * @param res - the response to write.
   */
  const opening = async (req, res) => {
    const login = requireLogin(ctx, req, res)
    if (login === undefined) return
    const body = await readJsonBody(req)
    if (body !== undefined && body.clientTimeZone !== undefined && typeof body.clientTimeZone !== 'string') {
      sendJson(res, 400, { error: '请求格式不正确' })
      return
    }
    if (openings.has(login.sessionId)) {
      sendJson(res, 200, { opened: false })
      return
    }
    // The check above and this claim share one synchronous block, so two asks
    // racing here are still one greeting; a refused delivery below gives the
    // claim back.
    const clientTimeZone = usableTimeZone(body?.clientTimeZone)
    if (body?.clientTimeZone !== undefined && clientTimeZone === undefined) {
      ctx.logger.warn(`${name}: ignoring unusable clientTimeZone ${JSON.stringify(body.clientTimeZone)}`)
    }
    openings.set(login.sessionId, clientTimeZone ?? null)
    try {
      const found = await ctx.sessionController.resolveAgent(login.sessionId)
      if ('error' in found) throw found.error
      found.agent.followup(openingMessage())
    } catch (error) {
      openings.delete(login.sessionId)
      ctx.logger.error(`${name}: opening for Session ${login.sessionId} was refused: ${String(error)}`)
      sendJson(res, 503, { error: OPENING_ERROR })
      return
    }
    sendJson(res, 200, { opened: true })
  }

  registerJsonRoute(ctx, { label: name, path: '/login', method: 'POST', handler: login })
  registerJsonRoute(ctx, { label: name, path: '/logout', method: 'POST', handler: logout })
  registerJsonRoute(ctx, { label: name, path: '/session', method: 'GET', handler: current })
  registerJsonRoute(ctx, { label: name, path: '/opening', method: 'POST', handler: opening })
  registerJsonRoute(ctx, { label: name, path: '/demo-accounts', method: 'GET', handler: demoAccounts })
}

/**
 * The identity line contributed to every model request in a bound Session.
 * @param ctx - plugin context carrying the Customer table.
 * @param boundCustomers - the Session id → Customer id binding.
 * @param context - the assembly context; carries the Agent when one exists.
 * @returns the identity text, or `''` when the Session has no Customer.
 */
function identityText(ctx, boundCustomers, context) {
  const customer = boundCustomer(ctx, boundCustomers, context)
  if (customer === undefined) return ''
  return `当前客户：${customer.accountName}（VIP 等级：${TIER_LABELS[customer.tier]}${customer.isAdmin ? '，管理员' : ''}）。`
}

/**
 * The opening protocol, contributed to every model request in a bound Session.
 *
 * The trigger is delivered by this plugin's own route, so the message and what
 * it means live together. Without this text the model reads the first message
 * of the Session as something the Customer typed and waits to be told what they
 * want; with it, the greeting and the card are one opening move.
 *
 * It stays for the whole Session on purpose: two of its rules — what to do when
 * the Customer answers 否, and how to turn a vague time into an absolute range —
 * are for the turns after the opening, and the Customer's own message carries
 * no protocol of its own. The zone sentence is the same kind of fact: the
 * trigger is not a browser-sent message, so the harness's clock context reports
 * the browser zone as unavailable for the opening turn and, throttled to one
 * reading every ten minutes, keeps saying so for the turns that follow.
 * @param ctx - plugin context carrying the Customer table.
 * @param boundCustomers - the Session id → Customer id binding.
 * @param openings - the Session id → browser zone the opening carried.
 * @param context - the assembly context; carries the Agent when one exists.
 * @returns the opening protocol, or `''` when the Session has no Customer.
 */
function openingText(ctx, boundCustomers, openings, context) {
  const customer = boundCustomer(ctx, boundCustomers, context)
  if (customer === undefined) return ''
  const zone = openings.get(context.agent?.session?.id)
  return [
    `开场：客户登录后，客户端会请宿主代客户发出本会话的第一条消息，内容就是「${OPENING_MESSAGE}」。`,
    '那是「客户已就座、可以开始服务」的信号，不是客户本人打的字。收到它时，在同一回合内做完两件事：',
    '先用「您好，请问您咨询的是这个订单吗？」向客户问好，',
    `紧接着调用 ${SEARCH_ORDERS_TOOL}，不带任何参数——它会把该客户时间最近的那一笔订单作为卡片推给客户确认。`,
    '不要等客户报订单号，也不要先问客户要查哪一笔。',
    `客户在卡片上点「否」时（工具返回 declined），不要重复推同一张卡片，而要请客户说个大概的租借时间和地点，再按条件查一次。`,
    '客户说的时间通常是模糊说法（「上周三」「昨天下午」）。按本轮注入的当前时间与浏览器时区把它换算成绝对日期范围（「上周三」就是上一个周三那一整天），'
      + `再作为 rentedFrom / rentedTo 传给 ${SEARCH_ORDERS_TOOL}。`,
    ...zone === undefined || zone === null
      ? []
      : [`客户浏览器的时区是 ${zone}（登录时由浏览器告知宿主）：注入的时钟若说浏览器时区不可用，按这个时区读，不要反问客户时区。`],
  ].join('')
}

/**
 * Build the trigger message.
 *
 * The harness's own constructor for this is `createUserMessage`
 * (`packages/llm/llm/src/message.ts`): a fresh uuid identity, the content, the
 * source, deep-frozen. This directory cannot import it (ADR-0006), so the same
 * four facts are written here by hand. The freeze is part of the contract, not
 * decoration: the agent loop keys its per-message accounting on identity.
 * @returns the message the opening route delivers.
 */
function openingMessage() {
  return deepFreeze({
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text: OPENING_MESSAGE }],
    source: { kind: OPENING_SOURCE_KIND },
  })
}

/**
 * Freeze a message and everything it carries.
 * @param value - the value to freeze, recursively.
 * @returns the same value.
 */
function deepFreeze(value) {
  if (typeof value === 'object' && value !== null) for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

/**
 * The browser zone an opening request may carry, or `undefined` when it may not.
 *
 * The value crosses a wire boundary, and the harness refuses a `clientTimeZone`
 * it cannot resolve to a canonical name — a refusal this route cannot turn into
 * a greeting. Resolving it here means a name that is no zone at all costs the
 * opening its clock reading rather than the whole greeting.
 * @param value - the body's `clientTimeZone`, when the request carried one.
 * @returns the canonical zone name, or `undefined` when there is none to carry.
 */
function usableTimeZone(value) {
  if (typeof value !== 'string' || value === '') return undefined
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone
  } catch {
    // Intl rejects a name that is no zone at all; the opening goes ahead
    // without one, and the caller reports what was dropped.
    return undefined
  }
}

/**
 * Resolve the Customer a prompt assembly belongs to.
 * @param ctx - plugin context carrying the Customer table.
 * @param boundCustomers - the Session id → Customer id binding.
 * @param context - the assembly context; carries the Agent when one exists.
 * @returns the Customer row, or `undefined` when the assembly is for no Agent
 *   or for a Session with no binding.
 */
function boundCustomer(ctx, boundCustomers, context) {
  const sessionId = context.agent?.session?.id
  if (sessionId === undefined) return undefined
  return customerById(ctx, boundCustomers, sessionId)
}

/**
 * Project a Customer row into the fields a browser may see.
 * @param customer - the stored Customer row.
 * @returns account name, tier, tier label, and admin flag — never the hash.
 */
function publicCustomer(customer) {
  return {
    accountName: customer.accountName,
    tier: customer.tier,
    tierLabel: TIER_LABELS[customer.tier],
    isAdmin: customer.isAdmin,
  }
}

/**
 * Resolve the Customer bound to a Session.
 * @param ctx - plugin context carrying the Customer table.
 * @param boundCustomers - the Session id → Customer id binding.
 * @param sessionId - a Session id the login index produced.
 * @returns the Customer row, or `undefined` when that Session has no binding.
 */
function customerById(ctx, boundCustomers, sessionId) {
  const customerId = boundCustomers.get(sessionId)
  return customerId === undefined ? undefined : ctx.customerStore.findById(customerId)
}

/**
 * Read one cookie from the request.
 * @param req - the incoming request.
 * @param name - the cookie name to match.
 * @returns the decoded value, or `undefined` when absent.
 */
function readCookie(req, name) {
  const header = req.headers.cookie
  if (typeof header !== 'string') return undefined
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) continue
    return decodeURIComponent(segment.slice(at + 1).trim())
  }
  return undefined
}
