/**
 * 人工还宝: the fixed rules that decide it, carried out by the 校验 + 动作 pair
 * `validation.js` builds (ADR-0002). What is here is what makes this action
 * 人工还宝 — its rule, its words, and the write that closes an Order.
 *
 * The rules are business rules, not settings: no config field moves the
 * two-hour window, and none issues a grant without a verdict.
 */
import { orderLine, stampText } from '../shared/orders.js'
import { inDemoZone } from '../shared/time.js'
import { validationPair } from './validation.js'

/** The tool that decides, and the one that acts on its verdict. */
export const VALIDATE_MANUAL_RETURN_TOOL = 'validate_manual_return'
export const MANUAL_RETURN_TOOL = 'manual_return'

/** The two tools, in the order the protocol has the model use them. */
export const MANUAL_RETURN_TOOLS = [VALIDATE_MANUAL_RETURN_TOOL, MANUAL_RETURN_TOOL]

/** How long after the rental 人工还宝 stops being allowed. */
const MANUAL_RETURN_WINDOW_MS = 2 * 60 * 60 * 1000

/** What this action is called in the messages the model reads. */
const OPERATION = '人工还宝'

/** The refusal a power bank that has already come back gets. */
const ALREADY_RETURNED = '不允许人工还宝，该订单已归还'

/** The refusal an Order that has also been refunded gets: the money is back
 * too, so naming 已归还 would describe a status it no longer has. */
const ALREADY_REFUNDED = '不允许人工还宝，该订单已退款'

/**
 * Build the two 人工还宝 tools.
 * @param ctx - plugin context carrying the login binding and the Order table.
 * @param grants - the grant store 校验 issues into and the action claims from.
 * @returns the tool definitions, in the order the model is meant to use them.
 */
export function manualReturnTools(ctx, grants) {
  return validationPair(ctx, grants, {
    validateTool: VALIDATE_MANUAL_RETURN_TOOL,
    actionTool: MANUAL_RETURN_TOOL,
    operation: OPERATION,
    decide: manualReturnVerdict,
    perform: (customer, orderId, now) =>
      ctx.customerStore.markReturned(customer.customerId, orderId, inDemoZone(now)),
    report: order => `已还宝：${orderLine(order)}，归还时间 ${stampText(order.returnedAt)}。请把这个结果告知客户。`,
    validateLead: '按固定规则校验这笔订单能不能人工还宝，并把结论转达给客户。规则由代码判定，你不要自己判断，也不要因为客户坚持就改口径：',
    rules: '订单不是「进行中」（已归还或已退款，各按各自的状态回绝）→ 不允许；当前时间 − 租借时间 超过两小时（恰好两小时算允许）→ 不允许；否则允许。时间以服务端当前时间为准。',
    actionLead: '把一笔订单置为「已归还」并记录归还时间。',
  })
}

/**
 * Decide one Order against the fixed 人工还宝 rules.
 *
 * The status is read before the clock: a rental whose power bank is already
 * back is closed rather than late, and telling its Customer that two hours have
 * passed would name a rule the Order is no longer subject to. The refusal names
 * the status the Order is really in, so a refunded one is not called 已归还.
 * @param decision - the calling Customer, their Order, and the server instant.
 * @returns whether the return is allowed, and the sentence the Customer reads.
 */
function manualReturnVerdict({ order, now }) {
  if (order.status !== 'in_progress') {
    return { allowed: false, text: order.status === 'refunded' ? ALREADY_REFUNDED : ALREADY_RETURNED }
  }
  if (now - Date.parse(order.rentedAt) > MANUAL_RETURN_WINDOW_MS) {
    return { allowed: false, text: '不允许人工还宝，借出时间已超过两小时' }
  }
  return { allowed: true, text: '允许人工还宝' }
}
