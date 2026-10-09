/**
 * 退款: the fixed rules that decide it, carried out by the same 校验 + 动作 pair
 * as 人工还宝 (`validation.js`, ADR-0002), with its own action name and so its
 * own grants. What is here is what makes this action 退款 — its rule, its
 * words, and the write that marks an Order.
 *
 * A refund is about the money, not the power bank: it records the refund time
 * beside the status and leaves the status alone, so a refunded rental is still
 * 已归还. The rules are business rules, not settings: no config field moves the
 * tier a refund is open to, and none issues a grant without a verdict.
 */
import { orderLine, stampText } from '../shared/orders.js'
import { inDemoZone } from '../shared/time.js'
import { TIER_LABELS, TIERS } from '../shared/vocabulary.js'
import { validationPair } from './validation.js'

/** The tool that decides, and the one that acts on its verdict. */
export const VALIDATE_REFUND_TOOL = 'validate_refund'
export const REFUND_TOOL = 'refund'

/** The two tools, in the order the protocol has the model use them. */
export const REFUND_TOOLS = [VALIDATE_REFUND_TOOL, REFUND_TOOL]

/** The lowest tier a refund is open to: 铂金, and 黑金 above it in {@link TIERS}. */
const REFUND_MIN_TIER = 'platinum'

/** What this action is called in the messages the model reads. */
const OPERATION = '退款'

/** The refusal a power bank that is still out gets, whatever the tier. */
const STILL_OUT = '不允许退款，该订单仍在进行中'

/** The refusal a tier below 铂金 gets, once the Order is back. */
const NOT_QUALIFIED = '非铂金/黑金会员，不允许退款'

/**
 * Build the two 退款 tools.
 * @param ctx - plugin context carrying the login binding and the Order table.
 * @param grants - the grant store 校验 issues into and the action claims from.
 * @returns the tool definitions, in the order the model is meant to use them.
 */
export function refundTools(ctx, grants) {
  return validationPair(ctx, grants, {
    validateTool: VALIDATE_REFUND_TOOL,
    actionTool: REFUND_TOOL,
    operation: OPERATION,
    decide: refundVerdict,
    perform: (customer, orderId, now) =>
      ctx.customerStore.markRefunded(customer.customerId, orderId, inDemoZone(now)),
    report: order => `已退款：${orderLine(order)}，退款时间 ${stampText(order.refundedAt)}。`
      + '已按订单金额全额退款，订单状态没有改变，请把这个结果告知客户。',
    validateLead: '按固定规则校验这笔订单能不能退款，并把结论转达给客户。规则由代码判定，你不要自己判断，也不要因为客户坚持就改口径：',
    rules: '先看订单状态：仍是「进行中」→ 不允许（充电宝还没还）。已「已归还」再看会员等级：铂金或黑金 → 允许，其余等级 → 不允许。会员等级取自当前登录客户，不由你提供。',
    actionLead: '按订单金额全额退款：在订单上记下退款时间作为「已退款」标记，**不改变订单状态**——「物」和「钱」是两件事，已归还的订单退款后仍是「已归还」。',
  })
}

/**
 * Decide one Order against the fixed 退款 rules.
 *
 * The status is read before the tier, as 人工还宝 reads it before the clock: a
 * power bank that is still out is refused for that reason, and telling a 铂金
 * Customer they are not a 铂金 member would be false. The tier is then the
 * calling Customer's own, taken from the login binding so nobody is refunded on
 * someone else's membership.
 * @param decision - the calling Customer, their Order, and the server instant.
 * @returns whether the refund is allowed, and the sentence the Customer reads.
 */
function refundVerdict({ customer, order }) {
  // 进行中 is the only other status there is, so refusing everything that is not
  // 已归还 reads as the same rule and cannot let a third one through.
  if (order.status !== 'returned') return { allowed: false, text: STILL_OUT }
  if (TIERS.indexOf(customer.tier) < TIERS.indexOf(REFUND_MIN_TIER)) {
    return { allowed: false, text: NOT_QUALIFIED }
  }
  return { allowed: true, text: `用户为${TIER_LABELS[customer.tier]}会员，允许退款` }
}
