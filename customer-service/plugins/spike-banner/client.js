/**
 * Browser half of the spike plugin (issue #2). Hand-written in the closure
 * factory form the Client module system loads: running this bundle only
 * registers the factory, and the module body runs at first materialization.
 *
 * `require` answers from the loader's module table (React and the shared UI
 * libraries), so nothing here resolves through Node or a build step.
 *
 * `id` must equal the package name in package.json: the host keys the served
 * bundle by that name, and the loader matches the two verbatim.
 */
window.__ModuleLoader__.load({
  id: '@customer-service/spike-banner',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    function Banner({ t }) {
      return h('div', {
        'data-spike-banner': '',
        style: {
          padding: '12px 16px',
          background: '#247bbf',
          color: '#fff',
          font: '14px/1.5 system-ui, sans-serif',
        },
      }, t('message'))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('spikeBanner', {
          en: { message: 'Out-of-tree plugin loaded: customer-service/plugins/spike-banner' },
          zh: { message: '仓库外插件已加载：customer-service/plugins/spike-banner' },
        }))
        ctx.slots.inject('shell.bottom', () => ctx.slots.register({
          name: 'shell.bottom', locale: 'spikeBanner',
        }, Banner))
      },
    }
  },
})
