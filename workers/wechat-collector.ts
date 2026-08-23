import { Container } from "@cloudflare/containers";

interface WeChatEnv {
  WECHAT_CONTAINER: DurableObjectNamespace<WeChatCollectorContainer>;
  WECHAT_STATE: R2Bucket;
  WECHAT_ADMIN_USERNAME: string;
  WECHAT_ADMIN_PASSWORD: string;
  WECHAT_APP_SECRET: string;
  WECHAT_COLLECTOR_TOKEN: string;
  WECHAT_STATE_TOKEN: string;
  WECHAT_STATE_ENCRYPTION_KEY: string;
  WECHAT_WEREAD_COOKIE: string;
  WECHAT_STATE_URL: string;
  WECHAT_PUBLIC_URL: string;
}

const STATE_KEY = "wechat/state-v1.enc";
const MAX_STATE_BYTES = 25 * 1024 * 1024;
const encoder = new TextEncoder();

export class WeChatCollectorContainer extends Container<WeChatEnv> {
  defaultPort = 8001;
  sleepAfter = "15m";
  pingEndpoint = "container/";

  constructor(ctx: DurableObjectState<{}>, env: WeChatEnv) {
    super(ctx, env);
    this.envVars = {
      DB: "sqlite:///./data/db.db",
      USERNAME: env.WECHAT_ADMIN_USERNAME,
      PASSWORD: env.WECHAT_ADMIN_PASSWORD,
      SECRET_KEY: env.WECHAT_APP_SECRET,
      TOKEN_EXPIRE_MINUTES: "43200",
      RSS_FULL_CONTEXT: "True",
      RSS_PAGE_SIZE: "100",
      RSS_BASE_URL: `${env.WECHAT_PUBLIC_URL.replace(/\/$/, "")}/`,
      ENABLE_JOB: "True",
      HEADLESS: "true",
      STATE_URL: env.WECHAT_STATE_URL,
      STATE_TOKEN: env.WECHAT_STATE_TOKEN,
      STATE_UPLOAD_INTERVAL_SECONDS: "600",
      WECHAT_REFRESH_INTERVAL_SECONDS: "21600",
      WECHAT_WEREAD_COOKIE: env.WECHAT_WEREAD_COOKIE,
      WEREAD_PROFILE_DIR: "/app/data/weread-chrome-profile",
    };
  }
}

function container(env: WeChatEnv) {
  return env.WECHAT_CONTAINER.get(env.WECHAT_CONTAINER.idFromName("wechat-v2"));
}

function bearer(request: Request): string {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
}

function bytes(value: string): Uint8Array<ArrayBuffer> {
  try {
    const decoded = atob(value);
    const output = new Uint8Array(new ArrayBuffer(decoded.length));
    for (let index = 0; index < decoded.length; index++) output[index] = decoded.charCodeAt(index);
    return output;
  } catch {
    return new Uint8Array(new ArrayBuffer(0));
  }
}

async function stateKey(env: WeChatEnv): Promise<CryptoKey> {
  const raw = bytes(env.WECHAT_STATE_ENCRYPTION_KEY);
  if (raw.length !== 32) throw new Error("WECHAT_STATE_ENCRYPTION_KEY must be 32-byte base64");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptState(body: ArrayBuffer, env: WeChatEnv): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await stateKey(env),
    body,
  ));
  const output = new Uint8Array(4 + iv.length + cipher.length);
  output.set(encoder.encode("WRS1"));
  output.set(iv, 4);
  output.set(cipher, 16);
  return output;
}

async function decryptState(body: ArrayBuffer, env: WeChatEnv): Promise<ArrayBuffer> {
  const input = new Uint8Array(body);
  if (input.length < 33 || new TextDecoder().decode(input.slice(0, 4)) !== "WRS1") {
    throw new Error("invalid state archive");
  }
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: input.slice(4, 16) },
    await stateKey(env),
    input.slice(16),
  );
}

async function gateCookie(env: WeChatEnv): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`wechat-admin:${env.WECHAT_ADMIN_USERNAME}:${env.WECHAT_ADMIN_PASSWORD}`),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function adminAccess(request: Request, env: WeChatEnv) {
  const expected = await gateCookie(env);
  const cookie = request.headers.get("cookie") || "";
  if (cookie.split(/;\s*/).includes(`wechat_admin=${expected}`)) {
    return { ok: true, setCookie: false };
  }
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Basic ")) return { ok: false, setCookie: false };
  try {
    const [username, ...password] = atob(authorization.slice(6)).split(":");
    return {
      ok: username === env.WECHAT_ADMIN_USERNAME && password.join(":") === env.WECHAT_ADMIN_PASSWORD,
      setCookie: true,
    };
  } catch {
    return { ok: false, setCookie: false };
  }
}

async function proxy(request: Request, env: WeChatEnv, removeAuthorization = false) {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  if (removeAuthorization) headers.delete("authorization");
  return container(env).fetch(new Request(`http://container${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  }));
}

async function upstreamToken(env: WeChatEnv): Promise<string> {
  const response = await container(env).fetch("http://container/api/v1/wx/auth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username: env.WECHAT_ADMIN_USERNAME,
      password: env.WECHAT_ADMIN_PASSWORD,
    }),
  });
  const result = await response.json<{ access_token?: string }>();
  if (!response.ok || !result.access_token) throw new Error(`WeRSS auth HTTP ${response.status}`);
  return result.access_token;
}

async function loginStatus(env: WeChatEnv) {
  const token = await upstreamToken(env);
  const response = await container(env).fetch("http://container/api/v1/wx/weread/test", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  let result: { code?: number; message?: string } = {};
  try {
    result = await response.json();
  } catch {
    // HTTP status remains the fallback diagnostic.
  }
  return {
    ok: response.ok && result.code === 0,
    message: result.message || `HTTP ${response.status}`,
  };
}

async function status(env: WeChatEnv) {
  const checkedAt = Date.now();
  try {
    const [login, rss, savedState] = await Promise.all([
      loginStatus(env),
      container(env).fetch("http://container/feed/all.rss?limit=100"),
      env.WECHAT_STATE.head(STATE_KEY),
    ]);
    const xml = await rss.text();
    return {
      ok: rss.ok,
      loginValid: login.ok,
      loginMessage: login.message,
      feedItems: (xml.match(/<item[>\s]/g) || []).length,
      checkedAt,
      stateSavedAt: savedState?.uploaded?.getTime() || null,
    };
  } catch (error) {
    return { ok: false, loginValid: false, feedItems: 0, checkedAt, error: String(error).slice(0, 300) };
  }
}

export default {
  async fetch(request: Request, env: WeChatEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });

    if (url.pathname === "/internal/state") {
      if (bearer(request) !== env.WECHAT_STATE_TOKEN) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      if (request.method === "GET") {
        const object = await env.WECHAT_STATE.get(STATE_KEY);
        if (!object) return new Response(null, { status: 404 });
        return new Response(await decryptState(await object.arrayBuffer(), env), {
          headers: { "content-type": "application/zip" },
        });
      }
      if (request.method === "PUT") {
        const body = await request.arrayBuffer();
        if (!body.byteLength || body.byteLength > MAX_STATE_BYTES) {
          return Response.json({ error: "invalid state size" }, { status: 413 });
        }
        await env.WECHAT_STATE.put(STATE_KEY, await encryptState(body, env));
        return Response.json({ ok: true, bytes: body.byteLength });
      }
      return new Response(null, { status: 405 });
    }

    if (url.pathname === "/status") {
      if (bearer(request) !== env.WECHAT_COLLECTOR_TOKEN) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      return Response.json(await status(env));
    }

    if (url.pathname === "/collect") {
      if (bearer(request) !== env.WECHAT_COLLECTOR_TOKEN) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const login = await loginStatus(env);
      if (!login.ok) {
        return Response.json({ error: "wechat login invalid", message: login.message }, { status: 409 });
      }
      const response = await container(env).fetch("http://container/feed/all.rss?limit=100");
      return new Response(response.body, {
        status: response.status,
        headers: { "content-type": response.headers.get("content-type") || "application/xml" },
      });
    }

    const access = await adminAccess(request, env);
    if (!access.ok) {
      return new Response("微信公众号管理需要登录", {
        status: 401,
        headers: { "www-authenticate": 'Basic realm="微信公众号管理"' },
      });
    }
    const response = await proxy(request, env, access.setCookie);
    if (!access.setCookie) return response;
    const headers = new Headers(response.headers);
    headers.append(
      "set-cookie",
      `wechat_admin=${await gateCookie(env)}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`,
    );
    return new Response(response.body, { status: response.status, headers });
  },
};
