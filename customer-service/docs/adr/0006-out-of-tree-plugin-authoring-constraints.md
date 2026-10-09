# 仓库外插件的写法：零 import 的宿主半边 + 手写的客户端半边

`customer-service/` 下的插件不 import 任何 `@deepseek-ai/dsh-*`，宿主半边只用 `apply(ctx)` 拿到的 `ctx`，工具入参写成裸 JSON Schema；客户端半边手写成 `window.__ModuleLoader__.load({ id, factory })` 闭包工厂，不经 tsdown。

这不是偏好，是 spike 实证出来的边界（见 [spike 记录](../spike-out-of-tree-plugins.md)）：`customer-service/` 不是 pnpm workspace 成员，没有包为它建立软链，裸说明符在运行期解析不到；而仓库的 tsdown 客户端预设按 `packages/*/*/package.json` 查包名，查到不认识的包名就在构建期抛错。手写闭包工厂是仓库自己已经在用的形式（`apps/web/tests/fixtures/plugins/`、`cordis-plugin-development` 技能的模板），不需要新机制。

代价是这两半边都拿不到 harness 与 React 的类型检查。类型系统在这条路径上让位给人工核对，约定面只有三处：覆盖层里的加载行名字与路径、槽位名、包的 `dsh.client` 声明；升级 harness 时核对这三处即可。

## Considered Options

- **把 `customer-service/` 加进 pnpm workspace。** 裸说明符与 tsdown 预设都能直接用。但那样它就成了一等公民包：`pnpm install` 会为它建链，仓库的 workspace 级门禁（依赖检查、`verify-cordis-config`、`hygiene`）会扫到它，这正好是 [ADR-0003](0003-out-of-tree-local-plugin-directory.md) 要避免的成本。
- **在 `customer-service/` 里自建 `node_modules` 软链指回 `packages/`。** 能让 import 解析成功，也仅此而已：运行期要靠 `lib/` 已构建，等于把「先 `pnpm run build`」这条隐式前置固化进目录结构。而它并不会让 tsdown 预设变得可用——预设查的是 `packages/*/*/package.json` 这份清单，不是 Node 的解析结果。为一点类型检查换来一套手工维护的软链，不划算。
- **fork 一份 tsdown 客户端预设放进本目录。** 能恢复 TypeScript 书写，但要复制一份与 `packages/client/tsdown.client.ts` 同步演化的构建逻辑，且外部说明符表要与 `PLATFORM_MODULES` 对齐——这是把成本从「写的时候查一次」挪到「每次升级 harness 查一次」。真要用 TypeScript 写客户端半边时再单独立项。
