/**
 * HTTP plumbing shared by the customer-service host plugins: the route prefix,
 * the request-trust fence every client call passes, and the JSON helpers the
 * handlers use.
 *
 * Every client-facing call is a bare HTTP route rather than a remote method: a
 * remote method cannot read the login cookie, and the browser half is
 * hand-written outside the code-generation path (ADR-0003, ADR-0006).
 */

/** Route prefix. Every path below it is absolute and outside the reserved `/api`. */
export const ROUTE_PREFIX = '/customer-service'

/** Largest accepted request body, in bytes. Every body this demo accepts is tiny. */
const MAX_BODY_BYTES = 4096

/**
 * Register one exact route behind the request-trust fence.
 *
 * The fence refuses a cross-origin caller (403) before the handler runs. It
 * also answers 401 for a missing browser session, which a login route must
 * ignore: the whole point is to be reachable before logging in.
 * @param ctx - plugin context carrying the HTTP router.
 * @param route - effect label, path below {@link ROUTE_PREFIX}, the only HTTP
 *   method the route accepts, and the handler run once both checks pass.
 */
export function registerJsonRoute(ctx, route) {
  const full = `${ROUTE_PREFIX}${route.path}`
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: full,
    handler: async (req, res) => {
      if (ctx.connection.requestRejection(req) === 403) {
        sendJson(res, 403, { error: '请求来源不受信任' })
        return
      }
      if (req.method !== route.method) {
        res.setHeader('allow', route.method)
        sendJson(res, 405, { error: `请使用 ${route.method}` })
        return
      }
      try {
        await route.handler(req, res)
      } catch (error) {
        ctx.logger.error(`${route.label}: ${route.method} ${full} failed: ${String(error)}`)
        if (!res.headersSent) sendJson(res, 500, { error: '服务内部错误' })
        else res.end()
      }
    },
  }), `${route.label}: ${route.method} ${full}`)
}

/**
 * Write a JSON response.
 * @param res - the response to write.
 * @param status - the HTTP status code.
 * @param payload - the JSON-serializable body.
 */
export function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * Read and parse a bounded JSON request body.
 * @param req - the incoming request.
 * @returns the parsed object, or `undefined` when the body is absent, too
 *   large, not JSON, or not a JSON object.
 */
export async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  if (size === 0) return undefined
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    // A body that is not JSON cannot carry a request this demo accepts, and the
    // caller gets the same 400 as any other malformed request.
    return undefined
  }
}
