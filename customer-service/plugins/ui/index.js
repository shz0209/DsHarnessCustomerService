/**
 * Host half of the customer-service UI plugin (issue #3). It contributes no
 * host behavior; its only job is to give the Loader an enabled row, which is
 * what makes the Client module system discover this package's `./client`
 * bundle. The login gate and the account chip are both browser presentation,
 * driven entirely by the raw HTTP routes in `plugins/auth/`.
 */

/** Host plugin body — this package contributes browser presentation only. */
export function apply() {}
