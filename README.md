# 芝麻同看 · Zhima Watch

一个面向两个人的网页放映室。创建房间、分享邀请链接，让两端在各自设备上加载同一片源，一起看，也一起聊。

## 一键部署到 Cloudflare

**请先 Fork，再部署。** 点击右上角 **Fork**，进入自己账号下的仓库后，再点击下面的部署按钮。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](../../actions/workflows/deploy.yml)

1. Fork 本仓库，并进入自己的 Fork。上面的按钮使用相对链接，会打开当前仓库的部署工作流；原仓库不提供访客部署，在原仓库运行也会提示「请先 Fork」。
2. 在自己的 Fork 中打开 **Settings → Secrets and variables → Actions → New repository secret**，添加：

   | Secret | 内容 |
   | --- | --- |
   | `CLOUDFLARE_ACCOUNT_ID` | 你的 Cloudflare 账户 ID。 |
   | `CLOUDFLARE_API_TOKEN` | 你创建的 Cloudflare API 令牌；可使用「Edit Cloudflare Workers」模板，仅授权需要部署的账户。不要填写 Global API Key。 |

3. 打开 **Actions**，首次使用 Fork 时点击启用工作流，然后点击上面的 **Deploy to Cloudflare** 按钮，选择 **Run workflow → Run workflow**。
4. 工作流会检查 Fork 和凭据，安装依赖、运行测试、构建并部署 Worker、静态资源与 Durable Object。成功后在 **Deploy Worker and assets** 日志中查看站点的 `workers.dev` 地址；自定义域名可稍后在 Cloudflare 配置。

首次部署需完成 Cloudflare 账户的 Workers 设置并启用 `workers.dev` 子域名。更新时先在 Fork 中 **Sync fork**，再运行同一部署工作流。凭据只保存在自己仓库的 Actions Secrets 中，不要提交到代码或填写在 Issue 中。

## 功能

- 双人房间与邀请链接，支持 MP4 直链和 HLS（M3U8）的播放、暂停、跳转与倍速同步，可选择「缓冲时等对方」。
- 文字聊天与 12 个图像表情；聊天内容可作为视频弹幕显示。弹幕的字号、透明度、停留时间、区域和颜色偏好保存在当前浏览器，不改变对方的设置。
- 手机与电脑布局、全屏控制，以及浏览器支持时的视频画中画。
- 房间内语音：连麦（正常模式）与对讲模式。对讲时按住说话、松开停止发送；对方需要先启用语音，不会因收到对讲而自动开启麦克风。
- 无账号系统；昵称保存在本地，房间创建后 24 小时过期，最多两位成员同时加入。

前端使用 React、TypeScript、Vite、hls.js、Lucide 与 PeerJS；后端为 Cloudflare Workers，每个房间由一个 SQLite-backed Durable Object 管理状态。双方分别从原片源加载视频，Worker 传递播放状态和聊天内容，不代理或托管视频文件。

## 本地运行

需要 **Node.js 22+** 和 npm。Vite 本身支持 Node 20+，本项目当前锁定的 Wrangler 要求 Node 22+，因此项目的完整开发、检查与部署流程统一使用 Node 22+；CI 使用 Node 22。

```sh
npm ci
```

先准备 Worker 所需的静态资源，再在第一个终端启动本地后端：

```sh
npm run build
npm run dev:worker
```

在第二个终端启动前端：

```sh
npm run dev
```

打开 Vite 输出的本地地址。公开配置默认把 `/api`（含 WebSocket）代理到 `http://127.0.0.1:8787`，两个进程需要同时运行。Worker 的静态资源目录为 `dist/`，因此首次运行先构建一次。

环境示例见 [.env.example](.env.example) 与 [.dev.vars.example](.dev.vars.example)。需要覆盖配置时，将前者复制为 `.env.local`，将后者复制为 `.dev.vars` 后编辑；这些本地文件均已忽略。修改环境文件后重启对应开发进程。已有 `.env.local` 时先检查其中的 `DEV_API_ORIGIN`，它可能指向另一套后端；连接本地 Worker 时将其设为 `http://127.0.0.1:8787`。

本地 Worker 依赖 workerd；部分 PRoot 等容器环境无法正常运行该运行时。遇到此限制，可在支持的环境中运行 Worker，或将 `DEV_API_ORIGIN` 指向自己已有的后端。

## 配置

| 变量 | 使用位置 | 默认值与说明 |
| --- | --- | --- |
| `DEV_API_ORIGIN` | Vite 开发服务器 | 默认 `http://127.0.0.1:8787`。通过 `loadEnv` 读取 `.env` / `.env.local` 等文件，命令行同名环境变量优先；不需要 `VITE_` 前缀，不注入前端产物。 |
| `VITE_API_BASE` | 浏览器端，构建时注入 | 留空时使用页面同源地址。分开部署时填写后端完整源地址；其 `/api` 同时用于 HTTP 与 WebSocket。此值会公开，不可放入密钥。 |
| `ALLOWED_ORIGIN` | Worker | 默认只允许请求地址自身的同源来源。可额外允许一个前端精确 Origin，包含协议、主机和可选端口，不含路径或末尾斜杠。开发时放在 `.dev.vars`，部署时在 Worker 环境变量中设置。 |

同源部署和 Vite 代理通常不需要设置 `ALLOWED_ORIGIN`。开发代理保留 WebSocket、`changeOrigin` 与 `Origin` 请求头改写；分开部署时，浏览器直接访问后端，应同时设置 `VITE_API_BASE` 和 Worker 的 `ALLOWED_ORIGIN`。

## 构建、检查与部署

```sh
npm test
npm run build
npm run check:worker
```

[CI 工作流](.github/workflows/check.yml) 在 Node 22 上执行 `npm ci` 及上述三项检查，只做检查，不发布或部署。这些检查不能代替跨设备播放、麦克风权限、画中画及真实网络下的人工验收。

部署需要自己的 Cloudflare 账号及 Workers / Durable Objects 环境。在 Wrangler 中完成账号授权后：

```sh
npm run deploy
```

公开的 [wrangler.jsonc](wrangler.jsonc) 包含 Worker 名称、Durable Object 绑定与迁移、静态资源配置。部署到自己的账号时检查 Worker 名称是否合适；已有房间数据时，保持绑定、类名与迁移历史一致。自定义域名需要另行配置。

需要维护本地自定义域名等配置时，可在项目根目录复制公开配置为 `wrangler.local.jsonc` 并编辑 `routes`。这个文件已被忽略；已有文件应先核对再编辑。构建后可选择使用本地配置部署：

```sh
npm run build
npx wrangler deploy --config wrangler.local.jsonc
```

## 语音与隐私

语音基于 `peerjs@1.5.5` 与浏览器 WebRTC，默认使用公共 PeerServer `0.peerjs.com` 进行连接协商。项目不运行自有的音频服务器或语音信令服务器；ICE 配置明确为 **STUN-only**，没有 TURN 音频中继。受 NAT、防火墙和运营商网络影响，部分网络无法建立语音连接，公共信令服务也可能不可用。

首次启用麦克风需要主动操作并授权；浏览器也可能要求点击后才能收听远端声音。双方需要选择相同模式并启用语音：连麦由一方呼叫、另一方主动接听后持续通话；对讲只在按住时发送自己的声音，接收方开启语音即可收听，收到对讲不会自动开启其麦克风。对讲松手会停止本次麦克风采集；连麦在窗口失焦或切到后台时自动静音，返回后需手动取消静音。关闭语音、离开页面或房间连接失效时会释放麦克风。使用耳机可减少回声。

麦克风等权限需要 HTTPS 或浏览器认可的 localhost 安全上下文；通过手机访问局域网的普通 HTTP 地址不一定可用。P2P 连接中，对方可能看到你的 IP 地址；公共信令及 STUN 服务会接触 IP、连接标识等连接元数据。项目没有录音功能，也没有账号系统，但这不代表匿名或完全没有数据处理。

房间邀请链接包含入房凭据，请只分享给一起观看的人。房间状态及最近的聊天记录存储在 Durable Object 中，房间按 24 小时有效期过期清理。媒体链接会传给对方，双方也会直接访问片源服务；请使用有权观看、分享且双方都能访问的内容。

## 浏览器与片源限制

- 视频需要 HTTPS 地址，编码、浏览器能力、跨域策略与链接有效期都会影响播放；HLS 片源需要允许相应跨域请求。
- 网页浏览仅能嵌入允许被嵌入的页面。第三方网页内部的播放器、播放进度和导航无法自动同步。
- 画中画取决于浏览器、系统和视频支持情况，通常只显示视频本身，网页聊天、弹幕和控制层未必进入画中画。部分系统全屏同样不会显示网页弹幕。
- 播放同步受网络、解码、缓冲和系统调度影响。页面显示的延迟或偏差是估算，不保证跨设备毫秒级一致。
- 自动播放、声音、全屏、画中画和后台运行均可能受到浏览器的手势与权限限制。

## 许可与素材

项目代码采用 [MIT License](LICENSE)，版权为 `2026 Zhima Watch contributors`。第三方依赖各自适用其原许可证，见 [第三方声明](THIRD_PARTY_NOTICES.md)。

[衬线字体子集](src/assets/zhima-serif.woff) 来自 Noto Serif CJK SC，继续使用 SIL Open Font License 1.1；[完整字体许可](src/assets/fonts-OFL.txt) 原样取自字体内嵌元数据。SVG 插画为项目原创；12 个图像表情由生图模型生成。AI 生成素材的可版权性和使用条件会因适用法律而异，不保证其具有排他权或绝对不存在第三方权利问题。

本地环境文件、Wrangler 本地配置、构建产物、日志、`.aicode/` 工具数据及项目根目录历史 PNG 截图均被 `.gitignore` 忽略。后续需要公开的截图可有选择地放入 `docs/`，提交前自行审查内容。
