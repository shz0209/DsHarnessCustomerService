# Spike：仓库外本地插件能否被加载

结论：**通**。`customer-service/` 里的宿主插件与浏览器插件，都能经同一个 `--patch` 覆盖层、同一条 `pnpm dsh web` 命令加载，且 `packages/` 及本目录之外零改动。ADR-0003 的前提成立，不需要改打包方式。

被验证的问题只有一个：浏览器插件必须由宿主扫描加载行、定位包的 `package.json`、读取构建产物再经 `/plugins` 下发，这条链路从来没有在仓库外的目录上跑过。宿主插件那一半在 `packages/boot/app-boot/README.md` 里已被记为支持（插入行可以是绝对路径、file URL 或包名），浏览器那一半没有实证。

复现步骤与两条启动命令见 [README](../README.md)，下面只记证据。证据采集用了隔离的 `DSH_HOME=/tmp/spike-dsh-home`，会话日志因此不在 `~/.dsh`。

## 证据

**覆盖层解析。** `pnpm dsh --profile web --dump-config --patch customer-service/spike.overlay.yml` 打印出两行，名字都已锚定成覆盖层文件所在目录下的 `file://` URL，与调用时的工作目录无关：

```
- id: spike-host
  …: file:///Users/…/customer-service/plugins/spike-host/index.js
- id: spike-banner
  …: file:///Users/…/customer-service/plugins/spike-banner/index.js
```

**浏览器路径。** 用真实 Chrome 打开 Web UI，页面底部渲染出 `data-spike-banner` 元素，文本为「仓库外插件已加载：customer-service/plugins/spike-banner」，控制台零报错。宿主下发的插件清单里包含仓库外那一条，HTTP 200：

```
GET /plugins/??…,@customer-service/spike-banner/client.js,…&rev=…  200
```

**宿主路径。** 同一次启动里跑完一轮对话，会话日志 `session.v4.jsonl.zstd` 里出现该工具的调用与结果：

```
{"type":"tool/call","seq":18,…,"data":{"turn":1,"step":1,"callId":"mock-call-1",
 "name":"spike_echo","arguments":"{\"text\":\"ping-from-mock\"}"}}
{"type":"tool/result","seq":21,…,"data":{"turn":1,"step":1,…,
 "content":[{"type":"text","text":"spike-echo: ping-from-mock"}],"isError":false,…}}
```

## 实证得到的两条限制

这两条决定了后续所有 `customer-service/` 代码怎么写，已记入 [ADR-0006](adr/0006-out-of-tree-plugin-authoring-constraints.md)。

**仓库外的代码 import 不到 `@deepseek-ai/dsh-*`。** `customer-service/` 不是 pnpm workspace 成员，没有别的包为它建立软链。同一句 `import('@deepseek-ai/dsh-tools')`，从 `customer-service/plugins/spike-host/` 执行得到 `ERR_MODULE_NOT_FOUND`，从 `packages/core/tools/` 执行正常解析。所以宿主插件写成零 import：服务全部由 `apply(ctx)` 的 `ctx` 提供，工具入参声明写成裸 JSON Schema 字面量，代价是拿不到 harness 的类型检查。

**仓库的 tsdown 客户端预设拒绝仓库外的包名。** `packages/client/tsdown.client.ts` 的 `clientConfig` 把外部化判定交给 `clientExternals(id)`，后者查 `workspaceManifest(id)`——那个函数 glob `packages/*/*/package.json`，名字不在其中就抛错。构造配置本身不报错，抛错发生在构建期 rolldown 逐个询问裸说明符是否外部化时：

```
THROW @customer-service/spike-banner: tsdown: no packages/*/*/package.json declares the name @customer-service/spike-banner
OK    @deepseek-ai/dsh-client-ui-layout
```

所以客户端半边绕开这个预设，手写成 `window.__ModuleLoader__.load({ id, factory })` 闭包工厂，与仓库自己的 `apps/web/tests/fixtures/plugins/` 及 `cordis-plugin-development` 技能模板同形。

## 后续动作

- 保留手写客户端包的写法。本 spike 的两个插件就是基线，业务代码按这个形状长。
- 若以后要用 TypeScript 写客户端半边，需要给 `customer-service/` 配一份自己的 tsdown 配置，并确认外部化的 React 等说明符与 `PLATFORM_MODULES` 一致；先不要动 `packages/client/tsdown.client.ts`——改它等于把这份成本转回仓库。
- 覆盖层里新增插件行是纯追加，不需要改这个文件以外的任何东西。
