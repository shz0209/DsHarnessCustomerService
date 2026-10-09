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
import { readJsonBody, registerJsonRoute, sendJson } from '../shared/http.js'
import { TIER_LABELS } from '../shared/vocabulary.js'

/** Cordis plugin name. */
export const name = 'customer-service-auth'

/** Required services: the HTTP router, the request-trust fence, Session
 * creation, the prompt-context registry, the Workspace registry, and the
 * Customer table. */
export const inject = [
  'webServer', 'connection', 'sessionController', 'systemPrompt', 'workspaceRegistry', 'customerStore',
]

/** Cookie carrying the login. Opaque; it never contains a Customer id. */
const COOKIE_NAME = 'cs_session'

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
      if (sessionId !== undefined) boundCustomers.delete(sessionId)
    }
    res.setHeader('set-cookie', `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`)
    sendJson(res, 200, { ok: true })
  }

  registerJsonRoute(ctx, { label: name, path: '/login', method: 'POST', handler: login })
  registerJsonRoute(ctx, { label: name, path: '/logout', method: 'POST', handler: logout })
  registerJsonRoute(ctx, { label: name, path: '/session', method: 'GET', handler: current })
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
