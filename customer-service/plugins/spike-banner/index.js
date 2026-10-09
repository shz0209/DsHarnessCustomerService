/**
 * Host half of the spike browser plugin (issue #2). It contributes no host
 * behavior; its only job is to give the Loader an enabled row, which is what
 * makes the Client module system discover this package's `./client` bundle.
 */

/** Host plugin body — this package contributes browser presentation only. */
export function apply() {}
