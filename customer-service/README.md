# 共享充电宝智能客服

一套跑在 DeepSeek Harness 上的智能客服演示系统，全部代码放在本目录，经 `--patch` 覆盖层加载，不改动 `packages/`（见 [ADR-0003](docs/adr/0003-out-of-tree-local-plugin-directory.md)）。产品说明见 [docs/product-overview.md](docs/product-overview.md)，术语见 [CONTEXT.md](CONTEXT.md)。

## 启动

先构建一次 harness（本目录的插件不需要构建，理由见下）：

```sh
pnpm install --frozen-lockfile
pnpm run build
```

然后从**仓库根目录**启动 Web：

```sh
pnpm dsh web --patch customer-service/spike.overlay.yml
```

`--patch` 的路径相对当前工作目录解析，所以要带着 `customer-service/` 前缀从仓库根目录执行。覆盖层**内部**的插件名则相对覆盖层文件所在目录解析，所以那里写的相对路径不受调用目录影响，换目录执行只需要改 `--patch` 这一个参数。

## 当前状态：spike 骨架（issue #2）

本目录目前只有一条最小骨架，用来实证「仓库外本地目录里的浏览器插件能否被加载」。结论见 [docs/spike-out-of-tree-plugins.md](docs/spike-out-of-tree-plugins.md)。

```
spike.overlay.yml                 覆盖层：一次加载下面两个插件
plugins/spike-host/               宿主插件：注册一个回显固定文本的工具 spike_echo
plugins/spike-banner/             浏览器插件：在 Web UI 底部渲染一条横幅
  index.js                        宿主半边（空 apply，只为让 Loader 有一行）
  client.js                       浏览器半边，手写的闭包工厂，无构建步骤
```

两个插件都不需要构建：宿主半边不 import 任何包（服务全部由 `ctx` 提供），浏览器半边是 `window.__ModuleLoader__.load({ id, factory })` 形式的普通 JavaScript。这个写法的理由是仓库外的代码解析不到 `@deepseek-ai/dsh-*`，见 [ADR-0006](docs/adr/0006-out-of-tree-plugin-authoring-constraints.md)。

## 校验

启动后页面底部应出现一条蓝色横幅，即浏览器插件已加载。

宿主插件那半边需要在对话里真的调一次工具。不想用真 key 时，把模型适配器指向仓库自带的 mock 服务即可，启动命令不变：

```sh
pnpm run mock:llm --port 8123 --api-key mock-key \
  --sequence tool_call_success,success \
  --tool-name spike_echo --tool-arguments '{"text":"ping-from-mock"}'

DEEPSEEK_BASE_URL=http://127.0.0.1:8123/v1 DEEPSEEK_API_KEY=mock-key \
pnpm dsh web --patch customer-service/spike.overlay.yml
```

然后在对话里让客服调用 `spike_echo`。屏幕上会出现一条「工具调用 spike_echo」的卡片；落盘的会话日志里则有这次调用与它的结果：

```sh
zstd -dc ~/.dsh/sessions/*/*/session*.jsonl.zstd | grep -o '"name":"spike_echo"'
```

日志是 Zstandard 压缩的，且一次运行会写成多个连续的 zstd 帧，所以要用 `zstd -dc` 整段解开；普通 `grep` 直接搜文件搜不到明文。文件名带会话格式版本（如 `session.v4.jsonl.zstd`），所以通配写 `session*`。改用别的 `DSH_HOME` 时把路径换掉即可。
