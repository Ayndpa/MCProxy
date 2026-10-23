import { ROUTES, enabledRoutes, routeListHtml } from "./routes.js";
import { loadExtraRoutes, saveExtraRoutes } from "./store.js";

const CACHE_TTL = {
  immutable: 60 * 60 * 24 * 365,
  short: 60 * 5,
  none: 0,
};

/** 单个响应体上限，防止异常上游把 Worker 内存/时间预算打爆。 */
const MAX_BODY_BYTES = 512 * 1024 * 1024;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

export default {
  async fetch(request, env, ctx) {
    const started = Date.now();
    const url = new URL(request.url);
    const origin = `${url.protocol}//${url.host}`;

    // 简单的可用性探测，方便优选 IP 时判断节点是否健康
    if (url.pathname === "/__ping" || url.pathname === "/healthz") {
      return jsonResponse({
        ok: true,
        colo: request.cf?.colo ?? null,
        time: new Date().toISOString(),
      });
    }

    // 动态路由管理接口
    if (url.pathname === "/_routes") {
      return handleRoutes(request, env, url);
    }

    const token = env.PROXY_TOKEN?.trim();
    if (token) {
      const supplied = url.searchParams.get("token") ?? request.headers.get("x-proxy-token");
      if (supplied !== token) {
        return new Response("Forbidden: invalid or missing token", {
          status: 403,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
    }

    // 只合并当前启用的路由；自定义路由放前面，同长度前缀下覆盖内置路由
    const routes = [...(await loadExtraRoutes(env)), ...enabledRoutes()];

    // 最长前缀优先，保证 /fabric-maven 不会被 /fabric 抢走
    const sorted = [...routes].sort((a, b) => b.prefix.length - a.prefix.length);
    const route = sorted.find((r) => matchPrefix(url.pathname, r.prefix));

    if (!route) {
      if (url.pathname === "/" || url.pathname === "") {
        return new Response(routeListHtml(origin), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response(
        `404: 没有匹配 ${escapeHtml(url.pathname)} 的路由。访问 ${origin}/ 查看可用路由列表。`,
        { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("405: 仅支持 GET / HEAD", {
        status: 405,
        headers: { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" },
      });
    }

    const target = buildUpstreamUrl(url, route);

    // Cloudflare Cache API 不缓存大范围 Range 以外的组合，范围请求照常透传给源站
    const cacheKey = new Request(target.toString(), { method: "GET" });
    const cacheMode = CACHE_TTL[route.cache] !== undefined ? route.cache : "immutable";
    const ttl = CACHE_TTL[cacheMode];

    if (ttl > 0) {
      try {
        const hit = await caches.default.match(cacheKey);
        if (hit) {
          return withDebugHeaders(hit, { route: route.prefix, cached: true, started, cache: cacheMode });
        }
      } catch {
        // 缓存不可用时继续走源站
      }
    }

    try {
      const upstream = await fetch(target, {
        method: request.method,
        headers: buildRequestHeaders(request.headers, target),
        redirect: "follow",
      });

      if (upstream.status >= 400 && upstream.status < 500 && upstream.status !== 416) {
        // 源站 4xx 直接透传，不要污染缓存
        return withDebugHeaders(upstream, { route: route.prefix, cached: false, started, cache: cacheMode });
      }

      const response = new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: buildResponseHeaders(upstream.headers, target, ttl),
      });

      if (ttl > 0 && upstream.status === 200 && request.method === "GET" && !hasRange(request.headers)) {
        ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
      }

      return withDebugHeaders(response, { route: route.prefix, cached: false, started, cache: cacheMode });
    } catch (err) {
      const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
      headers.set("x-proxy-route", route.prefix);
      headers.set("x-proxy-cache", "MISS");
      headers.set("x-proxy-cache-mode", cacheMode);
      headers.set("x-proxy-time", String(Date.now() - started));
      return new Response(
        JSON.stringify(
          {
            ok: false,
            error: "upstream fetch failed",
            message: String(err?.message ?? err),
            route: route.prefix,
            target: target.toString(),
          },
          null,
          2
        ),
        { status: 502, headers }
      );
    }
  },
};

function matchPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

function buildUpstreamUrl(url, route) {
  let path = url.pathname;
  if (route.strip !== false) {
    path = path.slice(route.prefix.length) || "/";
  }
  const target = new URL(route.upstream);
  target.pathname = joinPath(target.pathname, path);
  target.search = url.search;
  return target;
}

function joinPath(base, rest) {
  const left = base.replace(/\/+$/, "");
  const right = rest.startsWith("/") ? rest : `/${rest}`;
  return `${left}${right}` || "/";
}

function buildRequestHeaders(incoming, target) {
  const headers = new Headers();
  for (const [key, value] of incoming) {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k)) continue;
    if (k === "host") continue;
    if (k === "cookie" && !value) continue;
    headers.set(key, value);
  }

  // 让上游按自己的域名处理 TLS / 虚拟主机
  headers.set("host", target.host);

  // 有些 CDN 会按 Accept-Encoding 返回 br，Worker 里回传给客户端没问题，
  // 但 zstd/其他编码在部分客户端上有兼容问题，统一只保留常见两种
  const ae = headers.get("accept-encoding");
  if (ae) headers.set("accept-encoding", "gzip, br");

  return headers;
}

function buildResponseHeaders(upstreamHeaders, target, ttl) {
  const headers = new Headers();
  for (const [key, value] of upstreamHeaders) {
    const k = key.toLowerCase();
    if (HOP_BY_HOP.has(k)) continue;
    headers.set(key, value);
  }

  headers.set("cache-control", buildCacheControl(ttl));
  headers.delete("set-cookie");
  headers.set("x-proxy-upstream", target.host);

  // 让客户端能区分 200 的来源，便于排查
  headers.set("vary", "accept-encoding");

  return headers;
}

function buildCacheControl(ttl) {
  if (ttl <= 0) return "no-store";
  const maxAge = Math.floor(ttl / 2);
  return `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=${ttl}`;
}

function withDebugHeaders(response, info) {
  const headers = new Headers(response.headers);
  headers.set("x-proxy-route", info.route);
  headers.set("x-proxy-cache", info.cached ? "HIT" : "MISS");
  headers.set("x-proxy-cache-mode", info.cache);
  headers.set("x-proxy-time", String(Date.now() - info.started));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function hasRange(headers) {
  return Boolean(headers.get("range"));
}

async function handleRoutes(request, env, url) {
  if (request.method === "GET") {
    return jsonResponse({
      enabled: [...(await loadExtraRoutes(env)), ...enabledRoutes()],
      all: ROUTES,
    });
  }

  // 写操作必须带管理令牌，否则任何人都能注册任意上游，等于开成开放代理
  if (!hasAdminToken(request, env, url)) {
    return jsonResponse(
      { ok: false, error: "forbidden: admin token required (x-admin-token or ?admin_token=)" },
      403
    );
  }

  if (request.method === "POST") {
    let parsed;
    try {
      parsed = await request.json();
    } catch {
      return jsonResponse({ ok: false, error: "body must be JSON" }, 400);
    }

    const list = Array.isArray(parsed) ? parsed : parsed?.routes;
    if (!Array.isArray(list)) {
      return jsonResponse({ ok: false, error: "expected an array of routes" }, 400);
    }

    const validated = [];
    for (const item of list) {
      const problem = validateRoute(item);
      if (problem) return jsonResponse({ ok: false, error: problem }, 400);
      validated.push(normalizeRoute(item));
    }

    // 动态路由一律视为启用：调用方显式注册，就是为了让它生效
    validated.forEach((r) => {
      r.enabled = true;
    });

    const persisted = await saveExtraRoutes(env, validated);
    return jsonResponse({
      ok: true,
      persisted,
      note: persisted
        ? "已保存，全边缘生效"
        : "未绑定 KV，动态路由仅在当前请求上下文可用（wrangler dev 会保留在内存直到重启）",
      routes: validated,
    });
  }

  return jsonResponse({ ok: false, error: "method not allowed" }, 405);
}

function hasAdminToken(request, env, url) {
  const expected = env.ADMIN_TOKEN?.trim();
  if (!expected) {
    // 没有配置管理令牌时，禁止一切写操作
    return false;
  }
  const supplied = request.headers.get("x-admin-token") ?? url.searchParams.get("admin_token");
  return supplied === expected;
}

function validateRoute(item) {
  if (!item || typeof item !== "object") return "route must be an object";
  if (typeof item.prefix !== "string" || !item.prefix.startsWith("/")) return "prefix must start with /";
  if (item.prefix === "/") return "prefix cannot be /";
  try {
    new URL(item.upstream);
  } catch {
    return "upstream must be a valid absolute URL";
  }
  if (item.cache && !(item.cache in CACHE_TTL)) return "cache must be immutable | short | none";
  return null;
}

function normalizeRoute(item) {
  const upstream = new URL(item.upstream);
  if (upstream.pathname.endsWith("/") && upstream.pathname.length > 1) {
    upstream.pathname = upstream.pathname.replace(/\/+$/, "");
  }
  return {
    prefix: item.prefix.replace(/\/+$/, ""),
    upstream: upstream.toString().replace(/\/+$/, ""),
    cache: item.cache ?? "immutable",
    strip: item.strip !== false,
    enabled: item.enabled !== false,
    description: item.description ?? "",
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
