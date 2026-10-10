/**
 * How one stored Order is projected for the model and for the browser, shared
 * by every plugin that returns one: a query result, a 人工还宝, and a 退款 all
 * describe the same row the same way.
 *
 * `customerId` is dropped from every projection: it is an opaque storage key
 * the model can neither use nor influence, and every Order it can reach is
 * already the caller's own (ADR-0004).
 */
import { ORDER_STATUSES, ORDER_STATUS_LABELS } from './vocabulary.js'

/** One Order as the model receives it. */
export const ORDER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['orderId', 'location', 'rentedAt', 'amountCents', 'status'],
  properties: {
    orderId: { type: 'string', description: '订单号。' },
    location: { type: 'string', description: '租借地点。' },
    rentedAt: { type: 'string', description: '租借时间，ISO-8601。' },
    amountCents: { type: 'integer', description: '金额，单位分。' },
    status: { type: 'string', enum: [...ORDER_STATUSES], description: '订单状态：进行中、已归还或已退款。' },
    returnedAt: { type: 'string', description: '归还时间，ISO-8601；尚未归还时没有这个字段。' },
    refundedAt: { type: 'string', description: '退款时间，ISO-8601；尚未退款时没有这个字段。' },
  },
}

/**
 * Project a stored Order row onto the fields the model may see.
 *
 * `returnedAt` and `refundedAt` ride along only once the Order has one: a field
 * is absent rather than empty, so a model reading the value cannot mistake a
 * missing return or refund time for a recorded one.
 * @param order - the stored Order row.
 * @returns the Order fields the model may see.
 */
export function publicOrder(order) {
  return {
    orderId: order.orderId,
    location: order.location,
    rentedAt: order.rentedAt,
    amountCents: order.amountCents,
    status: order.status,
    ...(order.returnedAt === undefined ? {} : { returnedAt: order.returnedAt }),
    ...(order.refundedAt === undefined ? {} : { refundedAt: order.refundedAt }),
  }
}

/**
 * One Order as the browser's cards show it: the fields the model may see, plus
 * the Chinese status label the model-facing schema has no room for (its fields
 * are closed).
 * @param order - a stored Order row or its projection.
 * @returns the Order the cards render.
 */
export function cardOrder(order) {
  return { ...publicOrder(order), statusLabel: ORDER_STATUS_LABELS[order.status] }
}

/**
 * One Order as a line of model-facing text.
 *
 * The status is the whole of it — 已退款 is a status, so a model reading any
 * later query about the Order reads the money being back from that word.
 * @param order - a stored Order row or its projection.
 * @returns the Order in one sentence, with its Chinese status.
 */
export function orderLine(order) {
  const amount = (order.amountCents / 100).toFixed(2)
  return `订单号 ${order.orderId}，租借地点 ${order.location}，租借时间 ${order.rentedAt}，`
    + `金额 ¥${amount}，状态 ${ORDER_STATUS_LABELS[order.status]}`
}

/**
 * One timestamp as the wall-clock text the conversation shows, which is the
 * time at the venue: the stored stamp already carries this deployment's offset.
 * @param stamp - an ISO-8601 timestamp, or `undefined` when there is none.
 * @returns `YYYY-MM-DD HH:MM`, or `''`.
 */
export function stampText(stamp) {
  return typeof stamp === 'string' ? stamp.slice(0, 16).replace('T', ' ') : ''
}
