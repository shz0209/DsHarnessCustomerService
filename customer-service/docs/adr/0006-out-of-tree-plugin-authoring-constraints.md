# 仓库外插件的写法：零 import 的宿主半边 + 手写的客户端半边

`customer-service/` 下的插件不 import 任何 `@deepseek-ai/dsh-*`，宿主半边只用 `apply(ctx)` 拿到的 `ctx`，工具入参写成裸 JSON Schema；客户端半边手写成 `window.__ModuleLoader__.load({ id, factory })` 闭包工厂，不经 tsdown。

这不是偏好，是 spike 实证出来的边界（见 [spike 记录](../spike-out-of-tree-plugins.md)）：`customer-service/` 不是 pnpm workspace 成员，没有包为它建立软链，裸说明符在运行期解析不到；而仓库的 tsdown 客户端预设按 `packages/*/*/package.json` 查包名，查到不认识的包名就在构建期抛错。手写闭包工厂是仓库自己已经在用的形式（`apps/web/tests/fixtures/plugins/`、`cordis-plugin-development` 技能的模板），不需要新机制。

代价是这两半边都拿不到 harness 与 React 的类型检查。类型系统在这条路径上让位给人工核对，约定面只有三处：覆盖层里的加载行名字与路径、槽位名、包的 `dsh.client` 声明；升级 harness 时核对这三处即可。

## 修正：`zod` 是唯一可解析的例外（issue #3）

上面「裸说明符在运行期解析不到」对 `@deepseek-ai/dsh-*` 成立，对**仓库根目录自己依赖的包**不成立：Node 从本目录向上找 `node_modules`，会在仓库根找到 `zod`，所以 `plugins/store/index.js` 里 `import { z } from 'zod'` 能解析。

这条例外无法避免，因为 issue #1 指定用 **storage-domain** 取库，而它对表的要求是 `valueSchema: ZodType<V>` 并在读盘时调 `.parse()`（`packages/storage/storage-domain/src/spec.ts:29`）——手写的仿造对象在第一次读取时就会炸。于是约定面从三处变四处，多出来的一处是：**本目录可以 import 的包，仅限仓库根 `package.json` 直接依赖、且与 harness 版本无关的那些**（目前只有 `zod`）。要新加一个之前，先确认它不属于 `@deepseek-ai/dsh-*`，并且没有别的办法拿到同样的能力。

`customerDomain` 仍按字面量手写、不走仓库的 `defineDomain` 校验器，理由不变：那个校验器 import 不到。

## Considered Options

- **把 `customer-service/` 加进 pnpm workspace。** 裸说明符与 tsdown 预设都能直接用。但那样它就成了一等公民包：`pnpm install` 会为它建链，仓库的 workspace 级门禁（依赖检查、`verify-cordis-config`、`hygiene`）会扫到它，这正好是 [ADR-0003](0003-out-of-tree-local-plugin-directory.md) 要避免的成本。
- **在 `customer-service/` 里自建 `node_modules` 软链指回 `packages/`。** 能让 import 解析成功，也仅此而已：运行期要靠 `lib/` 已构建，等于把「先 `pnpm run build`」这条隐式前置固化进目录结构。而它并不会让 tsdown 预设变得可用——预设查的是 `packages/*/*/package.json` 这份清单，不是 Node 的解析结果。为一点类型检查换来一套手工维护的软链，不划算。
- **fork 一份 tsdown 客户端预设放进本目录。** 能恢复 TypeScript 书写，但要复制一份与 `packages/client/tsdown.client.ts` 同步演化的构建逻辑，且外部说明符表要与 `PLATFORM_MODULES` 对齐——这是把成本从「写的时候查一次」挪到「每次升级 harness 查一次」。真要用 TypeScript 写客户端半边时再单独立项。
