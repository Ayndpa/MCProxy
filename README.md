# Fabric 加速代理（Cloudflare Workers）

把 Fabric 相关域名代理到 Cloudflare 全球边缘节点。国内客户端从就近的 Cloudflare 节点拉取，避开上游直连的跨境拥塞，用来加速 fabric-loader / fabric-api / intermediary 等 Maven 依赖的下载。

和同目录的 `McSpeed`（优选 Cloudflare IP 写 hosts）配合使用：McSpeed 负责给域名挑最优 IP，本 Worker 负责在那条线路上提供正确的 HTTP 代理。

**当前只开放 Fabric 生态三条路由**，其余路由的定义保留在 `src/routes.js` 中但暂停服务，请求返回 404。需要时把对应条目的 `enabled` 改成 `true` 即可恢复。

## 解决什么问题

- `maven.fabricmc.net` 在国内经常几十 KB/s，改 DNS 无用，瓶颈在跨境线路。
- Cloudflare 在国内有多个入口，不同运营商、不同时段质量差异很大。
- 本 Worker 把这些域名收敛到一个你自己的 Worker 域名下，客户端只改仓库地址，不需要逐个域名优选。

## 快速开始

```powershell
cd FabricProxy
npm install
npm run dev          # 本地 http://localhost:8787
```

部署：

```powershell
npx wrangler login
npm run deploy       # 得到 https://fabric-mc-proxy.<你的子域>.workers.dev
```

查看实时日志：`npm run tail`

## 内置路由

**当前开放：**

| 前缀 | 上游 | 用途 |
|---|---|---|
| `/fabric-maven/` | maven.fabricmc.net | fabric-loader / fabric-api / intermediary |
| `/fabric-meta/` | meta.fabricmc.net | Fabric 元数据 |
| `/fabric/` | fabricmc.net | Fabric 官网 |

访问 `/` 会返回这个列表的 HTML 页面，方便直接抄地址。

**已暂停（定义保留在 `src/routes.js`，请求返回 404）：**

Modrinth（cdn / api / 官网）、Paper（`/paper-fill/`、`/paper-api/`）、Mojang 与 Piston（libraries、版本元数据、客户端/服务端 jar、启动器资源）、Forge、NeoForged、Quilt、Sponge、CurseForge、Hangar、Spiget、GitHub、JitPack。

恢复某条路由只需在 `src/routes.js` 里把它的 `enabled` 改成 `true`，然后重新部署。

### 为什么停了

一是只服务 Fabric 场景，额度集中；二是其中几条上游本身已变更（PaperMC 重构了下载服务，`api.papermc.io/v2` 返回 410、`v3/projects` 返回 403，现在要用 `fill.papermc.io`），开着只会让人踩坑。真需要哪个再逐个开。

## 用法

只改仓库地址，其余不用动。Gradle：

```kotlin
repositories {
    maven {
        name = "FabricProxy"
        url = uri("https://你的域名/fabric-maven/")
    }
}
```

把 `maven.fabricmc.net/xxx` 换成 `你的域名/fabric-maven/xxx` 即可，子路径保持原样。

Maven：

```xml
<repositories>
  <repository>
    <id>fabric-proxy</id>
    <url>https://你的域名/fabric-maven/</url>
  </repository>
</repositories>
```

启动器/整合包下载链接同理替换前缀。

### 自定义仓库

需要先设 `ADMIN_TOKEN`，否则该接口的写操作一律返回 403：

```powershell
npx wrangler secret put ADMIN_TOKEN
```

之后注册：

```powershell
curl -X POST https://你的域名/_routes `
  -H "content-type: application/json" `
  -H "x-admin-token: 你的令牌" `
  -d '[{"prefix":"/mymaven","upstream":"https://example.com/maven","cache":"immutable","description":"自建仓库"}]'
```

- `strip`（默认 `true`）：是否把前缀从路径中去掉。设为 `false` 时会把前缀一起转发，适合上游本身带路径的镜像。
- `cache`：`immutable`（Maven 制品等，长缓存）/ `short`（元数据、版本清单）/ `none`。

GET `/_routes` 查看当前生效的全部路由，返回 `enabled`（生效中）和 `all`（含暂停的完整定义）两份清单。

想让自定义路由重启后仍然保留，在 `wrangler.toml` 里绑定 KV（文件中已有注释好的配置），或直接用 `EXTRA_ROUTES` 环境变量写死一份。

注意：通过 `EXTRA_ROUTES` 或 `POST /_routes` 注册的路由一律视为启用，不受 `src/routes.js` 里 `enabled: false` 的暂停策略影响。

### 访问令牌

公网部署建议设 `PROXY_TOKEN`，否则别人也能用你的 Worker 额度：

```powershell
npx wrangler secret put PROXY_TOKEN
```

之后请求带 `?token=xxx` 或 `x-proxy-token: xxx` 头。注意：写进仓库地址里的 token 会暴露给所有用这个地址的人，共享链接场景下更适合用 `x-proxy-token` 头配合自己的构建配置。

## 缓存策略

- `immutable`：边缘缓存 1 年。Maven 制品（jar、pom）内容不可变，适合长缓存。
- `short`：边缘缓存 5 分钟。版本清单、构建列表这类会变的内容。
- `none`：不缓存，直接透传。

命中情况通过响应头判断：

| 响应头 | 含义 |
|---|---|
| `x-proxy-route` | 命中的路由前缀 |
| `x-proxy-cache` | `HIT` / `MISS` |
| `x-proxy-cache-mode` | `immutable` / `short` / `none` |
| `x-proxy-time` | 本次处理耗时（ms） |
| `x-proxy-upstream` | 实际上游域名 |

## 健康检查

`GET /__ping`（或 `/healthz`）返回 JSON，含节点位置：

```json
{ "ok": true, "colo": "HKG", "time": "2026-10-22T06:33:54.000Z" }
```

可以配合 McSpeed 对多个 Worker 域名（或优选 IP 后的地址）做测速，挑最快的用。

## 项目结构

```
FabricProxy/
  src/
    index.js     Worker 入口：鉴权、路由匹配、缓存、上游请求
    routes.js    内置路由表（含 enabled 开关）+ 首页 HTML
    store.js     自定义路由存储（KV 优先，EXTRA_ROUTES 变量兜底）
  wrangler.toml  部署配置
```

## 已知限制

- 只支持 `GET` / `HEAD`。Maven 上传等写操作不走这里。
- 上游 4xx 直接透传且不缓存，避免把错误响应长期缓存。
- Range 请求透传给源站，不写 Cloudflare Cache，避免分片缓存把额度打满。
- Workers 免费额度每日 10 万次请求。加速 jar 下载时一次构建可能几十个请求，自用足够；若公开分享建议设 `PROXY_TOKEN`。
- 暂停的路由仍在代码里，改 `enabled` 后需重新部署才生效。
