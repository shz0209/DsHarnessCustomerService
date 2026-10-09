/**
 * The Customer vocabulary shared by the host plugins.
 *
 * The tier name is the source of truth; {@link TIERS} is in ascending order, so
 * a position in it is the rank a "platinum or above" rule compares. Order
 * statuses are the whole lifecycle, and it runs one way: 进行中 (the power bank
 * is out) → 已归还 (it came back) → 已退款 (the money went back).
 */

/** VIP tiers, ascending. The array order is the rank order. */
export const TIERS = ['silver', 'gold', 'platinum', 'black_gold']

/** Chinese display name per tier, shown on the login page and in the sidebar. */
export const TIER_LABELS = {
  silver: '白银',
  gold: '黄金',
  platinum: '铂金',
  black_gold: '黑金',
}

/** Order statuses. `in_progress` is the power bank being out with the Customer. */
export const ORDER_STATUSES = ['in_progress', 'returned', 'refunded']

/** Chinese display name per Order status, shown on every card and in the panel. */
export const ORDER_STATUS_LABELS = {
  in_progress: '进行中',
  returned: '已归还',
  refunded: '已退款',
}
