/**
 * 上游路由表：把请求前缀映射到真实地址。
 *
 * - prefix    本代理下的路径前缀
 * - upstream  上游 origin，如 https://maven.fabricmc.net
 * - cache     immutable | short | none
 * - strip     是否把前缀从路径中去掉（false 时原样转发路径）
 * - enabled   false 表示定义保留但不提供服务，请求返回 404。
 *             缺省同样视为不启用——新增路由必须显式写 enabled: true。
 */
export const ROUTES = [
  // ---------- Fabric 生态（当前唯一开放） ----------
  {
    prefix: "/fabric-maven",
    upstream: "https://maven.fabricmc.net",
    cache: "immutable",
    enabled: true,
    description: "Fabric Maven 仓库（fabric-loader / fabric-api / intermediary）",
  },
  {
    prefix: "/fabric-meta",
    upstream: "https://meta.fabricmc.net",
    cache: "short",
    enabled: true,
    description: "Fabric 元数据与版本查询",
  },
  {
    prefix: "/fabric",
    upstream: "https://fabricmc.net",
    cache: "short",
    enabled: true,
    description: "Fabric 官网",
  },

  // ---------- 以下暂停服务：定义保留，请求返回 404 ----------
  {
    prefix: "/modrinth-cdn",
    upstream: "https://cdn.modrinth.com",
    cache: "immutable",
    enabled: false,
    description: "Modrinth 文件下载（mod / 资源包）",
  },
  {
    prefix: "/modrinth-api",
    upstream: "https://api.modrinth.com",
    cache: "short",
    enabled: false,
    description: "Modrinth API v2",
  },
  {
    prefix: "/modrinth",
    upstream: "https://modrinth.com",
    cache: "short",
    enabled: false,
    description: "Modrinth 官网",
  },
  {
    prefix: "/paper-fill",
    upstream: "https://fill.papermc.io",
    cache: "short",
    enabled: false,
    description: "Paper / Velocity / Folia Downloads Service（现用，需带 User-Agent）",
  },
  {
    prefix: "/paper-api",
    upstream: "https://api.papermc.io",
    cache: "short",
    enabled: false,
    description: "PaperMC 旧 API（v2 已废弃返回 410，v3 端点已迁移，见 /paper-fill）",
  },
  {
    prefix: "/mojang",
    upstream: "https://launcher.mojang.com",
    cache: "short",
    enabled: false,
    description: "Mojang 启动器资源与版本清单",
  },
  {
    prefix: "/piston-meta",
    upstream: "https://piston-meta.mojang.com",
    cache: "short",
    enabled: false,
    description: "Piston 版本元数据",
  },
  {
    prefix: "/piston-data",
    upstream: "https://piston-data.mojang.com",
    cache: "immutable",
    enabled: false,
    description: "Piston 服务端 / 客户端 jar",
  },
  {
    prefix: "/maven",
    upstream: "https://libraries.minecraft.net",
    cache: "immutable",
    enabled: false,
    description: "Minecraft libraries 仓库（paperweight 等构建也用）",
  },
  {
    prefix: "/forge",
    upstream: "https://maven.minecraftforge.net",
    cache: "immutable",
    enabled: false,
    description: "Forge Maven",
  },
  {
    prefix: "/neoforged",
    upstream: "https://maven.neoforged.net",
    cache: "immutable",
    enabled: false,
    description: "NeoForged Maven",
  },
  {
    prefix: "/sponge",
    upstream: "https://repo.spongepowered.org",
    cache: "immutable",
    enabled: false,
    description: "Sponge Maven",
  },
  {
    prefix: "/quilt",
    upstream: "https://maven.quiltmc.org",
    cache: "immutable",
    enabled: false,
    description: "Quilt Maven",
  },
  {
    prefix: "/curseforge-cdn",
    upstream: "https://edge.forgecdn.net",
    cache: "immutable",
    enabled: false,
    description: "CurseForge / Forge CDN",
  },
  {
    prefix: "/hangar",
    upstream: "https://hangar.papermc.io",
    cache: "short",
    enabled: false,
    description: "Hangar 插件仓库",
  },
  {
    prefix: "/spiget",
    upstream: "https://api.spiget.org",
    cache: "short",
    enabled: false,
    description: "Spiget API",
  },
  {
    prefix: "/github",
    upstream: "https://github.com",
    cache: "short",
    enabled: false,
    description: "GitHub（raw 用 /github-raw）",
  },
  {
    prefix: "/github-raw",
    upstream: "https://raw.githubusercontent.com",
    cache: "immutable",
    enabled: false,
    description: "GitHub Raw",
  },
  {
    prefix: "/jitpack",
    upstream: "https://jitpack.io",
    cache: "immutable",
    enabled: false,
    description: "JitPack Maven",
  },
];

/** 当前实际提供服务的路由。 */
export function enabledRoutes() {
  return ROUTES.filter((r) => r.enabled === true);
}

/** 路由未命中时展示的页面，列出当前可用路由。 */
export function routeListHtml(origin) {
  const active = enabledRoutes();
  const rows = active
    .map(
      (r) => `      <tr>
        <td><code>${escapeHtml(r.prefix)}/</code></td>
        <td>${escapeHtml(r.upstream)}</td>
        <td>${escapeHtml(r.description)}</td>
      </tr>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Fabric 加速代理</title>
  <style>
    :root { color-scheme: light dark; }
    body { font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif;
           max-width: 900px; margin: 3rem auto; padding: 0 1.25rem; }
    h1 { font-size: 1.6rem; margin-bottom: .25rem; }
    h2 { font-size: 1.05rem; margin-top: 2rem; }
    p, li { opacity: .85; }
    table { width: 100%; border-collapse: collapse; margin-top: .75rem; font-size: .92rem; }
    th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid currentColor; }
    th { opacity: .6; font-weight: 600; }
    code { background: color-mix(in srgb, currentColor 12%, transparent);
           padding: .1em .35em; border-radius: 4px; }
    pre { background: color-mix(in srgb, currentColor 10%, transparent);
          padding: .75rem .9rem; border-radius: 8px; overflow-x: auto; }
  </style>
</head>
<body>
  <h1>Fabric 加速代理</h1>
  <p>基于 Cloudflare Workers，把 Fabric 相关域名代理到 Cloudflare 边缘节点。
     当前只开放 Fabric 生态，其余路由已在代码中保留但暂停服务。</p>

  <h2>可用路由</h2>
  <table>
    <thead><tr><th>前缀</th><th>上游</th><th>说明</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>

  <h2>用法</h2>
  <p>在仓库地址或启动器镜像里把域名换成本 Worker 地址，例如把
     <code>https://maven.fabricmc.net/</code> 换成 <code>${escapeHtml(origin)}/fabric-maven/</code>：</p>
  <pre>repositories {
    maven {
        name = "FabricProxy"
        url = uri("${escapeHtml(origin)}/fabric-maven/")
    }
}</pre>
</body>
</html>
`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
