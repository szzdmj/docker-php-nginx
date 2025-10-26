import { Container, getContainer } from "@cloudflare/containers";

/**
 * Container class for the PHP+Nginx app.
 * The Cloudflare "containers" feature will create Durable Object classes
 * from this Container subclass when you bind it in wrangler.jsonc.
 */
export class AppContainer extends Container {
  // Default port the container serves on (inside the container)
  defaultPort = 80;

  // After being idle for this duration the runtime may sleep the instance.
  // Adjust as needed for your usage patterns.
  sleepAfter = "5m";
}

type Env = {
  // Durable Object binding name you will add to wrangler.jsonc (example: "APP_CONTAINER")
  APP_CONTAINER: DurableObjectNamespace<AppContainer>;
  // Optional: number of container instances for sticky hashing
  INSTANCE_COUNT?: string;
};

/* -- Utility helpers ------------------------------------------------------ */

function parseCookie(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  header.split(/;\s*/).forEach((kv) => {
    const i = kv.indexOf("=");
    if (i > 0) out[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
  });
  return out;
}

/**
 * Choose a sticky name for the container instance using a cookie.
 * Returns an object with instance name and optional Set-Cookie header value.
 */
function chooseStickyName(req: Request, count: number): { name: string; setCookie?: string } {
  const cookies = parseCookie(req.headers.get("cookie"));
  const key = "SZZD_CONTAINER";
  let shard = cookies[key];
  if (!shard) {
    const n = Math.max(1, count | 0);
    shard = String(Math.floor(Math.random() * n));
    const cookie = `${key}=${encodeURIComponent(shard)}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax`;
    return { name: `client-${shard}`, setCookie: cookie };
  }
  return { name: `client-${shard}` };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a container to be ready by probing its root path.
 * This will call stub.start() first and then repeatedly probe using stub.fetch().
 * Treats any status < 500 as "ready".
 */
async function ensureContainerReady(
  stub: ReturnType<typeof getContainer>,
  timeoutMs = 120_000
) {
  const startT = Date.now();
  await stub.start();
  let wait = 300;
  let lastErr: unknown;

  // Use GET / probe. Some Nginx/virtual-host setups expect Host header.
  const probe = new Request("http://container/", {
    method: "GET",
    headers: { Host: "localhost", Connection: "close" },
  });

  while (Date.now() - startT < timeoutMs) {
    try {
      const r = await stub.fetch(probe);
      // 2xx/3xx/4xx are acceptable for "listening" (anything < 500)
      if (r && r.status < 500) return;
      lastErr = `status ${r.status}`;
    } catch (e) {
      lastErr = e;
    }
    await sleep(wait);
    wait = Math.min(wait * 2, 5_000);
  }

  throw new Error(
    `Container not ready within ${timeoutMs}ms${lastErr ? `, last error: ${String(lastErr)}` : ""}`
  );
}

/* -- Worker entrypoint --------------------------------------------------- */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const count = Number(env.INSTANCE_COUNT ?? "1");
    const { name, setCookie } = chooseStickyName(request, count);

    // Get the Durable Object stub for this sticky client
    const stub = getContainer(env.APP_CONTAINER, name);

    // Wait for the container to be up and listening (warm-up). Increase timeout if cold-starts are frequent.
    try {
      await ensureContainerReady(stub, 180_000); // 3 minutes
    } catch (e) {
      return new Response(`Service warming up: ${String(e)}`, {
        status: 503,
        headers: { "Cache-Control": "no-store", "X-Container-State": "starting" },
      });
    }

    // Proxy the original request to the container
    const resp = await stub.fetch(request);

    // If we set a sticky cookie, append it to the response
    if (setCookie) {
      const headers = new Headers(resp.headers);
      headers.append("Set-Cookie", setCookie);
      return new Response(resp.body, { status: resp.status, headers });
    }

    // Return proxied response as-is
    return resp;
  },
};
