import { Container, getContainer } from "@cloudflare/containers";

/**
 * Durable Object Container class for the PHP+Nginx app.
 * Matches the binding name APP_CONTAINER in wrangler.jsonc.
 */
export class AppContainer extends Container {
  // Default port the container serves on (inside the container)
  defaultPort = 8080;

  // How long the instance may sleep after idling
  sleepAfter = "5m";
}

type Env = {
  APP_CONTAINER: DurableObjectNamespace<AppContainer>;
  // optional: number of instances to shard across for sticky routing
  INSTANCE_COUNT?: string;
};

function parseCookie(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  header.split(/;\s*/).forEach((kv) => {
    const i = kv.indexOf("=");
    if (i > 0) out[decodeURIComponent(kv.slice(0, i))] = decodeURIComponent(kv.slice(i + 1));
  });
  return out;
}

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

async function ensureContainerReady(stub: ReturnType<typeof getContainer>, timeoutMs = 120_000) {
  const startT = Date.now();
  await stub.start();
  let wait = 300;
  let lastErr: unknown;

  // probe root path; set Host because some Nginx configs require it
  const probe = new Request("http://container/", {
    method: "GET",
    headers: { Host: "localhost", Connection: "close" },
  });

  while (Date.now() - startT < timeoutMs) {
    try {
      const r = await stub.fetch(probe);
      // treat any status < 500 as "ready" (2xx/3xx/4xx acceptable)
      if (r && r.status < 500) return;
      lastErr = `status ${r.status}`;
    } catch (e) {
      lastErr = e;
    }
    await sleep(wait);
    wait = Math.min(wait * 2, 5_000);
  }

  throw new Error(`Container not ready within ${timeoutMs}ms${lastErr ? `, last error: ${String(lastErr)}` : ""}`);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const count = Number(env.INSTANCE_COUNT ?? "1");
    const { name, setCookie } = chooseStickyName(request, count);
    const stub = getContainer(env.APP_CONTAINER, name);

    try {
      await ensureContainerReady(stub, 180_000); // allow longer for cold starts
    } catch (e) {
      return new Response(`Service warming up: ${String(e)}`, {
        status: 503,
        headers: { "Cache-Control": "no-store", "X-Container-State": "starting" },
      });
    }

    const resp = await stub.fetch(request);

    if (setCookie) {
      const h = new Headers(resp.headers);
      h.append("Set-Cookie", setCookie);
      return new Response(resp.body, { status: resp.status, headers: h });
    }

    return resp;
  },
};
