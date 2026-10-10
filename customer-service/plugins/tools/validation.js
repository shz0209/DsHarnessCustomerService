/**
 * The 校验 + 动作 protocol every service action shares (ADR-0002): one tool
 * decides and issues a one-time 凭证, the other spends it and performs the
 * write. 人工还宝 and 退款 differ in their rule, their words, and what the write
 * does — never in how a grant is earned, spent or refused — so those are what
 * {@link validationPair} takes and the enforcement between them is written
 * once. Two copies of it would be two chances for one action to drift into
 * being reachable without its validation.
 *
 * Both tools take a bare `orderId`. The Customer comes from the login binding
 * rather than from an argument (ADR-0004), and the Order is looked up under
 * that Customer, so another Customer's Order is not found rather than merely
 * forbidden.
 */
import { GRANT_REFUSALS, GRANT_TTL_MS } from '../shared/grants.js'
import { ORDER_SCHEMA, cardOrder, publicOrder } from '../shared/orders.js'

/** The only argument either tool of a pair takes. */
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

/** What a 校验 returns: the verdict, and the sentence the Customer reads. */
const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'text'],
  properties: {
    verdict: { type: 'string', enum: ['allowed', 'denied'], description: '校验结论。' },
    text: { type: 'string', description: '要给客户看的结论原文，逐字转达。' },
  },
}

/** What every 校验 publishes: the verdict, and whether a grant came with it. */
const VERDICT_OUTPUT = {
  schema: VERDICT_SCHEMA,
  render: (_args, value) => [{
    type: 'text',
    text: value.verdict === 'allowed'
      ? `${value.text}。校验凭证已签发，十分钟内有效、只能用一次。`
      : value.text,
  }],
}

/**
 * Build one 校验 + 动作 pair.
 * @param ctx - plugin context carrying the login binding and the Order table.
 * @param grants - the grant store 校验 issues into and the action claims from.
 * @param action - the action's declaration.
 * @param action.validateTool - the 校验 tool's name.
 * @param action.actionTool - the action tool's name; it is also the action a
 *   grant binds, so two actions never spend each other's.
 * @param action.operation - the noun phrase the messages call this action
 *   (人工还宝, 退款).
 * @param action.decide - the fixed rule: given the calling Customer, their
 *   Order row and the server instant, returns `{ allowed, text }` — the verdict,
 *   and the sentence the Customer reads.
 * @param action.perform - the write, given the Customer, the Order number and
 *   the server instant; returns the stored Order as it now stands.
 * @param action.report - builds the sentence the model reads after the write.
 * @param action.validateLead - the 校验 description's opening line, which
 *   names this action.
 * @param action.rules - the 校验 description's line of fixed rules.
 * @param action.actionLead - the action description's opening line.
 * @returns the two tool definitions, 校验 first.
 */
export function validationPair(ctx, grants, action) {
  /**
   * Decide whether this Order may be acted on, and say so in the fixed words of
   * the rule.
   * @param args - the model's arguments; only `orderId` is accepted.
   * @param exec - the tool-call context.
   * @returns `allowed` with the sentence to relay, or `denied` with the reason.
   */
  function validate(args, exec) {
    const orderId = parseOrderId(args)
    const now = Date.now()
    const { customer, order } = ownOrder(ctx, exec, orderId, `校验${action.operation}`)
    const binding = grantBinding(customer, orderId, action.actionTool, exec.agent.session.id)
    const verdict = action.decide({ customer, order, now })
    if (!verdict.allowed) {
      // A refusal takes back any grant an earlier verdict earned, so the Order
      // can only be acted on while the newest 校验 still says it may be.
      grants.revoke(binding)
      return { verdict: 'denied', text: verdict.text }
    }
    grants.issue({ ...binding, issuedAt: now, order })
    return { verdict: 'allowed', text: verdict.text }
  }

  /**
   * Carry out this action on one Order, on the strength of a 校验 that passed
   * for it.
   * @param args - the model's arguments; only `orderId` is accepted.
   * @param exec - the tool-call context.
   * @returns the Order as it stands after the write.
   * @throws {Error} when there is no valid grant, which is every way of asking
   *   for this without a validation behind it.
   */
  async function act(args, exec) {
    const orderId = parseOrderId(args)
    const now = Date.now()
    const { customer, order } = ownOrder(ctx, exec, orderId, action.operation)
    // The grant is spent before the write, so two calls cannot spend the same
    // one, and a write that throws has spent it rather than left it live.
    const claim = grants.claim({
      ...grantBinding(customer, orderId, action.actionTool, exec.agent.session.id),
      now,
      order,
    })
    if (!claim.ok) throw new Error(refusalText(claim.reason, orderId, action.validateTool))
    const updated = await action.perform(customer, orderId, now)
    return { order: publicOrder(updated) }
  }

  return [
    {
      name: action.validateTool,
      description: [action.validateLead, action.rules, ...validateProtocolLines(action)].join('\n'),
      parameters: ORDER_PARAMETERS,
      output: VERDICT_OUTPUT,
      execute: validate,
    },
    {
      name: action.actionTool,
      description: [action.actionLead, ...actionProtocolLines(action)].join('\n'),
      parameters: ORDER_PARAMETERS,
      output: actionOutput(action.report),
      execute: act,
    },
  ]
}

/**
 * The sentences every 校验 tool's description carries after its own rule: what
 * the returned text is for, the grant a passing verdict hands over, and what an
 * action does when it has none.
 *
 * They are built here rather than written into each action's file because a
 * grant's terms are the protocol's, not one action's — and two copies of them
 * are two chances for an action's instructions to drift from what it enforces.
 * @param action - the action's declaration, for its two tool names and its noun.
 * @returns the lines, in the order the description reads.
 */
function validateProtocolLines(action) {
  return [
    '返回值里的 text 就是要说给客户的结论原文，逐字转达，不要改写。',
    `校验通过时会签发一张一次性凭证：只对这笔订单、这个动作和本次会话有效，十分钟过期，订单一经变更即失效，再校验一次而结论变成不允许时也会作废。请接着在十分钟内调用 ${action.actionTool} 完成${action.operation}；凭证用一次即废，之后再要${action.operation}必须重新校验。`,
    `校验不通过时不要调用 ${action.actionTool}——没有凭证它一定会拒绝；把 text 里的理由告诉客户即可。`,
  ]
}

/**
 * The sentences every action tool's description carries after its own: the one
 * way to reach it, and the fact that it takes no customer argument.
 * @param action - the action's declaration, for its 校验 tool's name.
 * @returns the lines, in the order the description reads.
 */
function actionProtocolLines(action) {
  return [
    `必须先调用 ${action.validateTool} 校验通过：没有有效凭证时本工具直接拒绝，不做任何改动。客户怎么要求都不能跳过校验。`,
    '本工具没有客户参数：客户身份来自当前登录，只能操作本客户名下的订单。',
  ]
}

/**
 * The output declaration every action publishes: the Order it wrote, plus the
 * Chinese status label the card needs and the model-facing schema has no room
 * for (its fields are closed).
 * @param report - builds the sentence the model reads from the written Order.
 * @returns the output declaration.
 */
function actionOutput(report) {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['order'],
      properties: { order: ORDER_SCHEMA },
    },
    render: (_args, value) => [{ type: 'text', text: report(value.order) }],
    // The card renders the settled Order from the persisted metadata, so the
    // Chinese status label rides along.
    presentationMeta: (_args, value) => ({ order: cardOrder(value.order) }),
  }
}

/**
 * What an action says when it has no valid grant to work with.
 * @param reason - the {@link GRANT_REFUSALS} reason the store reported.
 * @param orderId - the Order the model named, echoed back so the next call
 *   cannot be aimed at the wrong one.
 * @param validateTool - the 校验 tool that has to run before this action.
 * @returns the message the model reads.
 */
function refusalText(reason, orderId, validateTool) {
  switch (reason) {
    case GRANT_REFUSALS.missing:
      return `订单 ${orderId} 没有有效的校验凭证：请先调用 ${validateTool} 校验这笔订单。`
    case GRANT_REFUSALS.expired:
      return `订单 ${orderId} 的校验凭证已过期（签发后 ${GRANT_TTL_MS / 60_000} 分钟失效），请重新调用 ${validateTool} 校验。`
    // The remaining reason is `changed`, and it is the safe reading of anything
    // else: a refusal the model can act on beats an action that should not run.
    default:
      return `订单 ${orderId} 在校验之后发生了变更，原凭证已失效，请重新调用 ${validateTool} 校验。`
  }
}

/**
 * The four things one grant binds, as the store files them.
 *
 * Both halves of a pair build it the same way, so a grant issued by 校验 and a
 * claim made by the action cannot disagree about who earned it or what it is
 * for. The action a grant authorises is named by the tool that spends it, which
 * is also what keeps two actions' grants apart.
 * @param customer - the calling Customer, resolved from the login binding.
 * @param orderId - the Order number the model named.
 * @param actionTool - the tool the grant authorises.
 * @param sessionId - the Session the call runs in.
 * @returns the binding.
 */
function grantBinding(customer, orderId, actionTool, sessionId) {
  return {
    customerId: customer.customerId,
    orderId,
    action: actionTool,
    sessionId,
  }
}

/**
 * Read the caller's Customer and their Order off the login binding.
 * @param ctx - plugin context carrying the login binding and the Order table.
 * @param exec - the tool-call context.
 * @param orderId - the Order the model named.
 * @param operation - what the caller is doing, named as a noun phrase the
 *   customer would recognize (校验人工还宝, 退款), for the messages below.
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
    throw new TypeError(`${ORDER_PARAMETER} 必须是非空字符串，例如 cbb14662-4d88-4361-9710-9a4229c1c960。`)
  }
  return args.orderId.trim()
}
