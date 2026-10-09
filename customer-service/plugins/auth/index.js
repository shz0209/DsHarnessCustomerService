/**
 * Customer Service auth: the login and logout routes, the harness-session ↔
 * Customer binding, and the identity the model is told about.
 *
 * The binding lives in this process only. It is set when a login succeeds and
 * dropped on logout, so a restart requires logging in again — acceptable for a
 * demo, and the reason no binding table exists in the store. Tools resolve the
 * Customer through `customerIdentity`, never through a tool argument (ADR-0004).
 *
 * Every client-facing call is a bare HTTP route, not a remote method: a remote
 * method cannot read the login cookie, and the browser half is hand-written
 * outside the code-generation path (ADR-0003).
 */
import { randomBytes } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { TIER_LABELS } from '../shared/vocabulary.js'

/** Cordis plugin name. */
export const name = 'customer-service-auth'

/** Route prefix. Every path below is absolute and outside the reserved `/api`. */
export const ROUTE_PREFIX = '/customer-service'

/** Required services: the HTTP router, the request-trust fence, Session
 * creation, the prompt-context registry, the Workspace registry, and the
 * Customer table. */
export const inject = [
  'webServer', 'connection', 'sessionController', 'systemPrompt', 'workspaceRegistry', 'customerStore',
]

/** Cookie carrying the login. Opaque; it never contains a Customer id. */
const COOKIE_NAME = 'cs_session'

/** Largest accepted request body, in bytes. Credentials are tiny. */
const MAX_BODY_BYTES = 4096

/** Prompt-context position. Sorted after the shipped delegation context (120). */
const IDENTITY_CONTEXT_ORDER = 130

/** The one message a failed login shows. It names neither field, on purpose. */
const CREDENTIALS_ERROR = '账号或密码错误'

/**
 * Register the routes, publish `customerIdentity`, and contribute the identity
 * to every model request in a bound Session.
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

  ctx.provide('customerIdentity', {
    /**
     * Resolve the Customer bound to a harness Session.
     * @param sessionId - the Session id the caller is operating in.
     * @returns the Customer row, or `undefined` when nothing is bound.
     */
    forSession(sessionId) {
      const customerId = boundCustomers.get(sessionId)
      return customerId === undefined ? undefined : ctx.customerStore.findById(customerId)
    },
  })

  ctx.systemPrompt.context({
    name: 'customer-service:identity',
    order: IDENTITY_CONTEXT_ORDER,
    required: true,
    interpolate: false,
    text: context => identityText(ctx, boundCustomers, context),
  })

  /**
   * Answer the current login state from the login cookie.
   * @param req - the incoming request.
   * @param res - the response to write.
   */
  const current = (req, res) => {
    const token = readCookie(req, COOKIE_NAME)
    const sessionId = token === undefined ? undefined : sessionsByToken.get(token)
    const customer = sessionId === undefined
      ? undefined
      : customerById(ctx, boundCustomers, sessionId)
    if (customer === undefined || sessionId === undefined) {
      sendJson(res, 200, { loggedIn: false })
      return
    }
    sendJson(res, 200, { loggedIn: true, ...publicCustomer(customer), sessionId })
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
      if (sessionId !== undefined) boundCustomers.delete(sessionId)
    }
    res.setHeader('set-cookie', `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`)
    sendJson(res, 200, { ok: true })
  }

  registerRoute(ctx, '/login', 'POST', login)
  registerRoute(ctx, '/logout', 'POST', logout)
  registerRoute(ctx, '/session', 'GET', current)
  registerRoute(ctx, '/demo-accounts', 'GET', demoAccounts)
}

/**
 * Register one exact route behind the request-trust fence.
 *
 * The fence refuses a cross-origin caller (403) before the handler runs. It
 * also answers 401 for a missing browser session, which a login route must
 * ignore: the whole point is to be reachable before logging in.
 * @param ctx - plugin context carrying the HTTP router.
 * @param path - path below {@link ROUTE_PREFIX}.
 * @param method - the only HTTP method this route accepts.
 * @param handler - handler run once the fence and the method check pass.
 */
function registerRoute(ctx, path, method, handler) {
  const full = `${ROUTE_PREFIX}${path}`
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: full,
    handler: async (req, res) => {
      if (ctx.connection.requestRejection(req) === 403) {
        sendJson(res, 403, { error: '请求来源不受信任' })
        return
      }
      if (req.method !== method) {
        res.setHeader('allow', method)
        sendJson(res, 405, { error: `请使用 ${method}` })
        return
      }
      try {
        await handler(req, res)
      } catch (error) {
        ctx.logger.error(`customer-service-auth: ${method} ${full} failed: ${String(error)}`)
        if (!res.headersSent) sendJson(res, 500, { error: '服务内部错误' })
        else res.end()
      }
    },
  }), `customer-service-auth: ${method} ${full}`)
}

/**
 * The identity line contributed to every model request in a bound Session.
 * @param ctx - plugin context carrying the Customer table.
 * @param boundCustomers - the Session id → Customer id binding.
 * @param context - the assembly context; carries the Agent when one exists.
 * @returns the identity text, or `''` when the Session has no Customer.
 */
function identityText(ctx, boundCustomers, context) {
  const sessionId = context.agent?.session?.id
  if (sessionId === undefined) return ''
  const customer = customerById(ctx, boundCustomers, sessionId)
  if (customer === undefined) return ''
  return `当前客户：${customer.accountName}（VIP 等级：${TIER_LABELS[customer.tier]}${customer.isAdmin ? '，管理员' : ''}）。`
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

/**
 * Read and parse a bounded JSON request body.
 * @param req - the incoming request.
 * @returns the parsed object, or `undefined` when the body is absent, too
 *   large, not JSON, or not a JSON object.
 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  if (size === 0) return undefined
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    // A body that is not JSON cannot carry credentials, and the caller gets the
    // same 400 as any other malformed request.
    return undefined
  }
}

/**
 * Write a JSON response.
 * @param res - the response to write.
 * @param status - the HTTP status code.
 * @param payload - the JSON-serializable body.
 */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}
