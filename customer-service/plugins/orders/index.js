/**
 * Customer Service orders: the routes behind the panel (issue #9), where a
 * Customer sees every Order of their own and prepares the ones a demo needs —
 * create a rental, close one — instead of editing the database by hand.
 *
 * The panel exists because the seeded Orders are frozen: the one 进行中 Order
 * each demo account carries was rented at a fixed instant, so a day later the
 * two-hour rule can only be shown refusing. Creating an Order rented just now
 * is what keeps the allowing side demonstrable.
 *
 * Every route is scoped to the login the way the tools are (ADR-0004): the
 * Customer comes from the cookie and never from the request body or query, so
 * a `customerId` in a request is a field this plugin does not have — and
 * another Customer's Order number is not found rather than refused. Nothing
 * here goes through 校验 + 凭证: that pair exists to stop the *model* acting
 * without a rule having run, and the panel is not the model. A model cannot
 * reach these routes at all — what it may call is the five tools of ADR-0005 —
 * and the panel's writes are a Customer's own rows, which is why it needs no
 * Administrator.
 *
 * The panel itself is browser presentation in `plugins/ui/client.js` and talks
 * to these routes the way the Card does, over bare HTTP (ADR-0003, ADR-0006).
 */
import { cardOrder } from '../shared/orders.js'
import { readJsonBody, registerJsonRoute, requireLogin, sendJson } from '../shared/http.js'
import { DEMO_ZONE_OFFSET, inDemoZone } from '../shared/time.js'
import { ORDER_STATUS_LABELS } from '../shared/vocabulary.js'

/** Cordis plugin name. */
export const name = 'customer-service-orders'

/** Required services: the HTTP router and its trust fence, the login binding,
 * and the Order table. */
export const inject = ['webServer', 'connection', 'customerIdentity', 'customerStore']

/** The fields `POST /orders/create` accepts. Anything else is rejected. */
const CREATE_FIELDS = ['location', 'amountCents', 'rentedAt']

/** The panel's `datetime-local` value: wall-clock in this deployment's zone. */
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

/**
 * Register the panel's routes.
 * @param ctx - plugin context carrying the HTTP router, the login binding, and
 *   the Order table.
 */
export function apply(ctx) {
  registerJsonRoute(ctx, { label: name, path: '/orders', method: 'GET', handler: listOrders(ctx) })
  registerJsonRoute(ctx, { label: name, path: '/orders/create', method: 'POST', handler: createOrder(ctx) })
  registerJsonRoute(ctx, { label: name, path: '/orders/return', method: 'POST', handler: closeOrder(ctx) })
}

/**
 * Build the handler that lists the calling Customer's own Orders.
 * @param ctx - plugin context carrying the login binding and the Order table.
 * @returns the route handler.
 */
function listOrders(ctx) {
  return (req, res) => {
    const login = requireLogin(ctx, req, res)
    if (login === undefined) return
    // No filter: the panel shows every Order the Customer has, 已归还 and
    // 已退款 ones included, newest first.
    const orders = ctx.customerStore.searchOrders(login.customer.customerId, {}).map(cardOrder)
    sendJson(res, 200, { orders })
  }
}

/**
 * Build the handler that creates one Order for the calling Customer.
 * @param ctx - plugin context carrying the login binding and the Order table.
 * @returns the route handler.
 */
function createOrder(ctx) {
  return async (req, res) => {
    const login = requireLogin(ctx, req, res)
    if (login === undefined) return
    const parsed = parseNewOrder(await readJsonBody(req))
    if ('error' in parsed) {
      sendJson(res, 400, { error: parsed.error })
      return
    }
    const created = await ctx.customerStore.createOrder({ customerId: login.customer.customerId, ...parsed.input })
    if (created === undefined) {
      // Unreachable through a login — the Customer row is the one the cookie
      // resolved — so this is a store the login outlived, not a bad request.
      sendJson(res, 409, { error: '当前客户已不存在，请重新登录。' })
      return
    }
    sendJson(res, 201, { order: cardOrder(created) })
  }
}

/**
 * Build the handler that closes one of the calling Customer's own Orders.
 * @param ctx - plugin context carrying the login binding and the Order table.
 * @returns the route handler.
 */
function closeOrder(ctx) {
  return async (req, res) => {
    const login = requireLogin(ctx, req, res)
    if (login === undefined) return
    const body = await readJsonBody(req)
    if (body === undefined || typeof body.orderId !== 'string' || body.orderId.trim() === ''
      || Object.keys(body).length !== 1) {
      sendJson(res, 400, { error: '请求格式不正确：本接口只接受 orderId。' })
      return
    }
    const orderId = body.orderId.trim()
    const closed = await ctx.customerStore.closeOpenOrder(login.customer.customerId, orderId, inDemoZone(Date.now()))
    if (!closed.ok) {
      // Another Customer's Order is `missing`, not `forbidden`: the panel is
      // not a place to learn which Order numbers exist.
      if (closed.reason === 'missing') sendJson(res, 404, { error: `订单不存在：${orderId}` })
      else {
        const label = ORDER_STATUS_LABELS[closed.order.status]
        sendJson(res, 409, { error: `订单 ${orderId} 已经是「${label}」，不能再归还。` })
      }
      return
    }
    sendJson(res, 200, { order: cardOrder(closed.order) })
  }
}

/**
 * Validate a create request into the fields the store takes.
 *
 * Validation belongs here, at the wire boundary: the body arrives from a
 * browser, so every field is checked and an unknown one is refused rather than
 * ignored — the owning Customer, the Order number and the status are the
 * server's to decide, and a request that tries to set any of them is told so
 * instead of being quietly overruled.
 * @param body - the parsed request body.
 * @returns the store's input, or the message to answer 400 with.
 */
function parseNewOrder(body) {
  if (body === undefined) return { error: '请求格式不正确：需要一个 JSON 对象。' }
  const unknown = Object.keys(body).filter(key => !CREATE_FIELDS.includes(key))
  if (unknown.length > 0) {
    return { error: `未知字段：${unknown.join('、')}。所属客户、订单号与订单状态由服务端决定，不能指定。` }
  }

  const { location, amountCents, rentedAt } = body
  if (typeof location !== 'string' || location.trim() === '') return { error: '租借地点不能为空。' }
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
    return { error: '金额必须是不小于 0 的整数（单位：分）。' }
  }
  const rented = parseRentedAt(rentedAt)
  if (rented === undefined) {
    return { error: '租借时间格式不正确：请用 2026-10-10T14:30，或留空表示当前时间。' }
  }
  return { input: { location: location.trim(), amountCents, rentedAt: rented } }
}

/**
 * Read the request's 租借时间, which the panel leaves empty for "now".
 * @param value - the body's `rentedAt`, as the panel's `datetime-local` posts it.
 * @returns the instant as an offset-carrying ISO-8601 stamp in this
 *   deployment's zone, or `undefined` when the value is unusable.
 */
function parseRentedAt(value) {
  if (value === undefined || value === '') return inDemoZone(Date.now())
  if (typeof value !== 'string' || !LOCAL_DATE_TIME.test(value)) return undefined
  // The field names no zone, and this deployment speaks exactly one.
  const instant = Date.parse(`${value}:00.000${DEMO_ZONE_OFFSET}`)
  if (!Number.isFinite(instant)) return undefined
  // A day that does not exist (a 31st of February) does not parse to NaN; it
  // rolls over into the next month, so the stamp has to read back as the value
  // that was sent, to the minute.
  const stamp = inDemoZone(instant)
  return stamp.startsWith(value) ? stamp : undefined
}
