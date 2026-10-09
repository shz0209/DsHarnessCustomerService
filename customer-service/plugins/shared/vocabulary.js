/**
 * The Customer vocabulary shared by the host plugins.
 *
 * The tier name is the source of truth; {@link TIERS} is in ascending order, so
 * a position in it is the rank a "platinum or above" rule compares.
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
