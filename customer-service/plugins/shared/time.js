/**
 * The zone this demo speaks, stated once because several things have to agree
 * on it: the seeded Orders carry `+08:00` stamps, the harness's clock context
 * tells the model to read unqualified times in the browser's zone (the same one
 * for anyone running this demo where it is meant to run), the query parameters
 * accept times in it, and a return time is recorded in it.
 */

/** The UTC offset every timestamp this demo shows carries. */
export const DEMO_ZONE_OFFSET = '+08:00'

/** {@link DEMO_ZONE_OFFSET} in milliseconds, for shifting an instant into it. */
const DEMO_ZONE_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * Render one instant as ISO-8601 in this deployment's zone.
 * @param instant - milliseconds since the epoch.
 * @returns e.g. `2026-09-21T08:05:00.000+08:00`.
 */
export function inDemoZone(instant) {
  const shifted = new Date(instant + DEMO_ZONE_OFFSET_MS).toISOString()
  return `${shifted.slice(0, -1)}${DEMO_ZONE_OFFSET}`
}
