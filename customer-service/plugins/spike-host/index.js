/**
 * Spike host plugin (issue #2). Registers one model-facing tool that echoes
 * fixed text, so a Loader row loaded from outside the workspace leaves an
 * observable trace in the session.
 *
 * Deliberately imports nothing: every service arrives on the plugin context,
 * and the tool schema is the raw JSON Schema the registry accepts. That keeps
 * the host half runnable from a directory the workspace dependency resolution
 * does not cover.
 */

/** Cordis plugin name. */
export const name = 'spike-host'

/** Required service: the scoped tool registry. */
export const inject = ['tools']

/**
 * Register the echo tool on this plugin's context.
 * @param ctx - plugin context carrying the tool registry.
 */
export function apply(ctx) {
  ctx.tools.register({
    name: 'spike_echo',
    description: 'Echo fixed text back. Present only to prove an out-of-tree host plugin loaded.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to echo back.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    /**
     * Echo the caller's text with a fixed prefix.
     * @param args - validated call arguments.
     * @returns the canonical result string.
     */
    async execute(args) {
      return `spike-echo: ${args.text}`
    },
  })
}
