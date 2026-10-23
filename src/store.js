/**
 * 运行时自定义路由。
 *
 * 优先级：KV（PROXY_ROUTES 绑定）> EXTRA_ROUTES 环境变量（JSON 数组）。
 * 都没有时返回空数组。
 */
export async function loadExtraRoutes(env) {
  if (env.PROXY_ROUTES) {
    try {
      const raw = await env.PROXY_ROUTES.get("routes", "json");
      if (Array.isArray(raw)) return raw;
    } catch {
      // KV 不可用时忽略，退到环境变量
    }
  }

  const fromVar = parseRoutesVar(env.EXTRA_ROUTES);
  return fromVar ?? [];
}

export async function saveExtraRoutes(env, routes) {
  if (!env.PROXY_ROUTES) return false;
  await env.PROXY_ROUTES.put("routes", JSON.stringify(routes));
  return true;
}

function parseRoutesVar(raw) {
  if (!raw || typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
