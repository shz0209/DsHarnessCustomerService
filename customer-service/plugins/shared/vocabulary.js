/**
 * The Customer vocabulary shared by the host plugins.
 *
 * The tier name is the source of truth; {@link TIERS} is in ascending order, so
 * a position in it is the rank a "platinum or above" rule compares. Order
 * statuses are the whole lifecycle: a refund is a mark on an Order, not a
 * status.
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
export const ORDER_STATUSES = ['in_progress', 'returned']

/** Chinese display name per Order status, shown on the order card. */
export const ORDER_STATUS_LABELS = {
  in_progress: '进行中',
  returned: '已归还',
}
