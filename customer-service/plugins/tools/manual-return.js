/**
 * 人工还宝: the fixed rules that decide it, and the two tools that carry it out.
 *
 * 校验 decides and does nothing else; a passing verdict issues the one-time
 * grant that the action spends (ADR-0002). So the action cannot close an Order
 * without a validation that passed for this Order, this Customer and this
 * Session — the rule is enforced where the Order is written, not in the prompt,
 * however the Customer or the model asks for it.
 *
 * The rules are business rules, not settings: no config field moves the
 * two-hour window, and none issues a grant without a verdict.
 */
import { GRANT_REFUSALS, GRANT_TTL_MS } from '../shared/grants.js'
import { ORDER_SCHEMA, orderLine, publicOrder, stampText } from '../shared/orders.js'
import { inDemoZone } from '../shared/time.js'
import { ORDER_STATUS_LABELS } from '../shared/vocabulary.js'

/** The tool that decides, and the one that acts on its verdict. */
export const VALIDATE_MANUAL_RETURN_TOOL = 'validate_manual_return'
export const MANUAL_RETURN_TOOL = 'manual_return'

/** The two tools, in the order the protocol has the model use them. */
export const MANUAL_RETURN_TOOLS = [VALIDATE_MANUAL_RETURN_TOOL, MANUAL_RETURN_TOOL]

/** The action name a 人工还宝 grant binds, so no other action can spend it. */
const MANUAL_RETURN_ACTION = 'manual_return'

/** How long after the rental 人工还宝 stops being allowed. */
const MANUAL_RETURN_WINDOW_MS = 2 * 60 * 60 * 1000

/** The verdict 人工还宝 may reach, as the model reads it. */
const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'text'],
  properties: {
    verdict: { type: 'string', enum: ['allowed', 'denied'], description: '校验结论。' },
    text: { type: 'string', description: '要给客户看的结论原文，逐字转达。' },
  },
}

/** What `manual_return` returns: the Order as it stands now. */
const RETURNED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['order'],
  properties: { order: ORDER_SCHEMA },
}

/** The only argument either tool takes. */
const ORDER_PARAMETER = 'orderId'

/** The argument schema both tools declare. */
const ORDER_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: [ORDER_PARAMETER],
  properties: {
    orderId: { type: 'string', description: '订单号，取自客户已确认的那一笔订单。' },
  },
}

/**
 * Build the two 人工还宝 tools.
 * @param ctx - plugin context carrying the login binding and the Order table.
 * @param grants - the grant store 校验 issues into and the action claims from.
 * @returns the tool definitions, in the order the model is meant to use them.
 */
export function manualReturnTools(ctx, grants) {
  /**
   * Decide whether this Order may be returned by hand, and say so in the fixed
   * words of the rule.
   * @param args - the model's arguments; only `orderId` is accepted.
   * @param exec - the tool-call context.
   * @returns `allowed` with the sentence to relay, or `denied` with the reason.
   */
  function validate(args, exec) {
    const orderId = parseOrderId(args)
    const now = Date.now()
    const { customer, order } = ownOrder(ctx, exec, orderId, '校验人工还宝')
    const binding = grantBinding(customer, orderId, exec.agent.session.id)
    const verdict = manualReturnVerdict(order, now)
    if (!verdict.allowed) {
      // A refusal takes back any grant an earlier verdict earned, so the Order
      // can only be closed while the newest 校验 still says it may be.
      grants.revoke(binding)
      return { verdict: 'denied', text: verdict.text }
    }
    grants.issue({ ...binding, issuedAt: now, order })
    return { verdict: 'allowed', text: verdict.text }
  }

  /**
   * Close this Order, on the strength of a 校验 that passed for it.
   * @param args - the model's arguments; only `orderId` is accepted.
   * @param exec - the tool-call context.
   * @returns the Order as it stands after the write.
   * @throws {Error} when there is no valid grant, which is every way of asking
   *   for this without a validation behind it.
   */
  async function act(args, exec) {
    const orderId = parseOrderId(args)
    const now = Date.now()
    const { customer, order } = ownOrder(ctx, exec, orderId, '人工还宝')
    const claim = grants.claim({
      ...grantBinding(customer, orderId, exec.agent.session.id),
      now,
      order,
    })
    if (!claim.ok) throw new Error(refusalText(claim.reason, orderId))
    const returnedAt = inDemoZone(now)
    const updated = await ctx.customerStore.markReturned(customer.customerId, orderId, returnedAt)
    return { order: publicOrder(updated) }
  }

  return [
    {
      name: VALIDATE_MANUAL_RETURN_TOOL,
      description: [
        '按固定规则校验这笔订单能不能人工还宝，并把结论转达给客户。规则由代码判定，你不要自己判断，也不要因为客户坚持就改口径：',
        `订单已是「已归还」→ 不允许；当前时间 − 租借时间 超过两小时（恰好两小时算允许）→ 不允许；否则允许。时间以服务端当前时间为准。`,
        '返回值里的 text 就是要说给客户的结论原文，逐字转达，不要改写。',
        `校验通过时会签发一张一次性凭证：只对这笔订单、这个动作和本次会话有效，十分钟过期，订单一经变更即失效，再校验一次而结论变成不允许时也会作废。请接着在十分钟内调用 ${MANUAL_RETURN_TOOL} 完成还宝；凭证用一次即废，之后再要还宝必须重新校验。`,
        `校验不通过时不要调用 ${MANUAL_RETURN_TOOL}——没有凭证它一定会拒绝；把 text 里的理由告诉客户即可。`,
      ].join('\n'),
      parameters: ORDER_PARAMETERS,
      output: {
        schema: VERDICT_SCHEMA,
        render: (_args, value) => [{
          type: 'text',
          text: value.verdict === 'allowed'
            ? `${value.text}。校验凭证已签发，十分钟内有效、只能用一次。`
            : value.text,
        }],
      },
      execute: validate,
    },
    {
      name: MANUAL_RETURN_TOOL,
      description: [
        '把一笔订单置为「已归还」并记录归还时间。',
        `必须先调用 ${VALIDATE_MANUAL_RETURN_TOOL} 校验通过：没有有效凭证时本工具直接拒绝，不做任何改动。客户怎么要求都不能跳过校验。`,
        '本工具没有客户参数：客户身份来自当前登录，只能操作本客户名下的订单。',
      ].join('\n'),
      parameters: ORDER_PARAMETERS,
      output: {
        schema: RETURNED_SCHEMA,
        render: (_args, value) => [{
          type: 'text',
          text: `已还宝：${orderLine(value.order)}，归还时间 ${stampText(value.order.returnedAt)}。请把这个结果告知客户。`,
        }],
        // The card renders the settled Order from the persisted metadata, so the
        // Chinese status label rides along (the model-facing schema is closed).
        presentationMeta: (_args, value) => ({
          order: { ...value.order, statusLabel: ORDER_STATUS_LABELS[value.order.status] },
        }),
      },
      execute: act,
    },
  ]
}

/**
 * Decide one Order against the fixed 人工还宝 rules.
 *
 * The status is read before the clock: a rental that has already been returned
 * is closed rather than late, and telling its Customer that two hours have
 * passed would name a rule the Order is no longer subject to.
 * @param order - the stored Order row.
 * @param now - the server's current time, in milliseconds since the epoch.
 * @returns whether the return is allowed, and the sentence the Customer reads.
 */
function manualReturnVerdict(order, now) {
  if (order.status === 'returned') return { allowed: false, text: '不允许人工还宝，该订单已归还' }
  if (now - Date.parse(order.rentedAt) > MANUAL_RETURN_WINDOW_MS) {
    return { allowed: false, text: '不允许人工还宝，借出时间已超过两小时' }
  }
  return { allowed: true, text: '允许人工还宝' }
}

/**
 * What the action says when it has no valid grant to work with.
 * @param reason - the {@link GRANT_REFUSALS} reason the store reported.
 * @param orderId - the Order the model named, echoed back so the next call
 *   cannot be aimed at the wrong one.
 * @returns the message the model reads.
 */
function refusalText(reason, orderId) {
  switch (reason) {
    case GRANT_REFUSALS.missing:
      return `订单 ${orderId} 没有有效的校验凭证：请先调用 ${VALIDATE_MANUAL_RETURN_TOOL} 校验这笔订单。`
    case GRANT_REFUSALS.expired:
      return `订单 ${orderId} 的校验凭证已过期（签发后 ${GRANT_TTL_MS / 60_000} 分钟失效），请重新调用 ${VALIDATE_MANUAL_RETURN_TOOL} 校验。`
    // The remaining reason is `changed`, and it is the safe reading of anything
    // else: a refusal the model can act on beats an action that should not run.
    default:
      return `订单 ${orderId} 在校验之后发生了变更，原凭证已失效，请重新调用 ${VALIDATE_MANUAL_RETURN_TOOL} 校验。`
  }
}

/**
 * The four things one 人工还宝 grant binds, as the store files them.
 *
 * Both halves build it the same way, so a grant issued by 校验 and a claim made
 * by the action cannot disagree about who earned it or what it is for.
 * @param customer - the calling Customer, resolved from the login binding.
 * @param orderId - the Order number the model named.
 * @param sessionId - the Session the call runs in.
 * @returns the binding.
 */
function grantBinding(customer, orderId, sessionId) {
  return {
    customerId: customer.customerId,
    orderId,
    action: MANUAL_RETURN_ACTION,
    sessionId,
  }
}

/**
 * Read the caller's Customer and their Order off the login binding.
 * @param ctx - plugin context carrying the login binding and the Order table.
 * @param exec - the tool-call context.
 * @param orderId - the Order the model named.
 * @param operation - what the caller is doing, named as a noun phrase the
 *   customer would recognize (校验人工还宝, 人工还宝), for the messages below.
 * @returns the calling Customer and the Order row.
 * @throws {Error} when the call is not in a Session bound to a Customer, or
 *   when the Order does not exist or belongs to another Customer.
 */
function ownOrder(ctx, exec, orderId, operation) {
  const agent = exec.agent
  if (agent === undefined) throw new Error(`${operation}必须在一个客户会话中进行。`)
  const customer = ctx.customerIdentity.forSession(agent.session.id)
  if (customer === undefined) throw new Error(`当前会话没有绑定客户，无法${operation}，请先登录。`)
  // Looking the Order up under this Customer is the isolation guarantee: an
  // Order belonging to anyone else is not found, whatever the model asks for.
  const order = ctx.customerStore.findOrder(customer.customerId, orderId)
  if (order === undefined) throw new Error(`订单 ${orderId} 不存在，或不属于当前客户，无法${operation}。`)
  return { customer, order }
}

/**
 * Validate and normalize the model's arguments.
 *
 * Validation belongs here, at the model boundary: a customer id or any other
 * field is rejected rather than ignored, so an attempt to address someone
 * else's Order fails loudly instead of quietly applying to the caller's own.
 * @param args - the parsed arguments from the model.
 * @returns the trimmed Order number.
 * @throws {TypeError} with the message the model reads, when the arguments are
 *   not a bare `orderId`.
 */
function parseOrderId(args) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new TypeError(`参数必须是一个对象，可用的字段：${ORDER_PARAMETER}。`)
  }
  const unknown = Object.keys(args).filter(key => key !== ORDER_PARAMETER)
  if (unknown.length > 0) {
    throw new TypeError(`未知参数：${unknown.join('、')}。本工具只接受 ${ORDER_PARAMETER}，没有客户参数——身份来自当前登录。`)
  }
  if (typeof args.orderId !== 'string' || args.orderId.trim() === '') {
    throw new TypeError(`${ORDER_PARAMETER} 必须是非空字符串，例如 ord-silver-1。`)
  }
  return args.orderId.trim()
}
