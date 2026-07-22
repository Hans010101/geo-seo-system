/**
 * Cloudflare Workers compatible auth module.
 *
 * Replaces node:crypto (scrypt, randomBytes, timingSafeEqual) with Web Crypto API
 * equivalents that work in the Workers runtime.
 *
 * JWT handling uses `jose` (already Web Crypto compatible).
 */

import type { Context } from "hono";
import type { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { SignJWT, jwtVerify } from "jose";
import * as db from "../server/db";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import type { User } from "../drizzle/schema";

// ─── Env access ───
function getEnv() {
  return (globalThis as any).__CF_ENV__ || {};
}

// ─── Password Hashing (Web Crypto PBKDF2 instead of node:crypto scrypt) ───

export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, "0")).join("");

  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", encoder.encode(plain), "PBKDF2", false, ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial, 512 // 64 bytes
  );
  const derivedHex = Array.from(new Uint8Array(derived))
    .map(b => b.toString(16).padStart(2, "0")).join("");

  return `${saltHex}:${derivedHex}`;
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  const [saltHex, keyHex] = hash.split(":");
  if (!saltHex || !keyHex) return false;

  // Check if this is a legacy node:crypto scrypt hash (salt is 32 hex chars = 16 bytes)
  // Both scrypt and PBKDF2 outputs are stored as salt:key, but they're not cross-compatible.
  // For the new system, all new passwords use PBKDF2.

  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(h => parseInt(h, 16)));
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", encoder.encode(plain), "PBKDF2", false, ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial, 512
  );
  const derivedHex = Array.from(new Uint8Array(derived))
    .map(b => b.toString(16).padStart(2, "0")).join("");

  // Constant-time comparison
  if (derivedHex.length !== keyHex.length) return false;
  let diff = 0;
  for (let i = 0; i < derivedHex.length; i++) {
    diff |= derivedHex.charCodeAt(i) ^ keyHex.charCodeAt(i);
  }
  return diff === 0;
}

// ─── JWT Session ───

function getSessionSecret() {
  const env = getEnv();
  const secret = env.JWT_SECRET || "geo-seo-system-jwt-secret-2026";
  return new TextEncoder().encode(secret);
}

export async function createSessionToken(openId: string, name: string): Promise<string> {
  const secretKey = getSessionSecret();
  const expirationSeconds = Math.floor((Date.now() + ONE_YEAR_MS) / 1000);

  return new SignJWT({ openId, name })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setExpirationTime(expirationSeconds)
    .sign(secretKey);
}

export async function verifySession(
  cookieValue: string | undefined | null
): Promise<{ openId: string; name: string } | null> {
  if (!cookieValue) return null;
  try {
    const secretKey = getSessionSecret();
    const { payload } = await jwtVerify(cookieValue, secretKey, { algorithms: ["HS256"] });
    const { openId, name } = payload as Record<string, unknown>;
    if (typeof openId !== "string" || !openId) return null;
    return { openId, name: (name as string) || "" };
  } catch {
    return null;
  }
}

// ─── Authenticate from Hono context ───

export async function authenticateRequestCf(c: Context): Promise<User | null> {
  const sessionCookie = getCookie(c, COOKIE_NAME);
  const session = await verifySession(sessionCookie);
  if (!session) return null;

  let user = await db.getUserByOpenId(session.openId);
  if (!user) {
    // If db/memory store doesn't have the user (e.g. Workers isolate cold start),
    // restore the user from the verified JWT payload so session is maintained seamlessly across refreshes.
    const isFirst = await isFirstUser();
    await db.upsertUser({
      openId: session.openId,
      name: session.name || session.openId,
      role: isFirst ? "admin" : "user",
      lastSignedIn: new Date(),
    });
    user = await db.getUserByOpenId(session.openId);
  }
  if (!user) return null;

  await db.upsertUser({ openId: user.openId, lastSignedIn: new Date() });
  return user;
}

// ─── Cookie helpers for Hono ───

function isSecureRequest(c: Context): boolean {
  const proto = c.req.header("x-forwarded-proto");
  if (proto?.includes("https")) return true;
  const url = new URL(c.req.url);
  return url.protocol === "https:";
}

function setSessionCookie(c: Context, token: string) {
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    path: "/",
    sameSite: "None",
    secure: isSecureRequest(c),
    maxAge: ONE_YEAR_MS / 1000,
  });
}

// ─── Helpers ───

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function isFirstUser(): Promise<boolean> {
  const users = await db.listUsers();
  return users.length === 0;
}

// ─── Register Auth Routes on Hono app ───

export function registerAuthRoutesCf(app: Hono<any>) {
  // Register
  app.post("/api/auth/register", async (c) => {
    try {
      const { username, password } = await c.req.json();
      if (!username || !password) return c.json({ error: "请输入用户名和密码" }, 400);
      if (typeof username !== "string" || typeof password !== "string")
        return c.json({ error: "输入格式无效" }, 400);
      if (username.includes("@") && !isValidEmail(username))
        return c.json({ error: "请输入有效的邮箱地址" }, 400);
      if (password.length < 6) return c.json({ error: "密码至少需要 6 个字符" }, 400);

      const existing = await db.getUserByOpenId(username);
      if (existing?.isBanned) return c.json({ error: "该账号已被禁用，请联系管理员" }, 403);
      if (existing) {
        return c.json(
          { error: username.includes("@") ? "该邮箱已被注册" : "该用户名已被注册" },
          409
        );
      }

      if (username.includes("@")) {
        const googleUser = await db.getUserByEmail(username);
        if (googleUser)
          return c.json({ error: "该邮箱已通过 Google 登录注册，请直接使用 Google 登录" }, 409);
      }

      const passwordHashValue = await hashPassword(password);
      const firstUser = await isFirstUser();

      await db.upsertUser({
        openId: username,
        name: username,
        email: username.includes("@") ? username : null,
        passwordHash: passwordHashValue,
        loginMethod: "password",
        role: firstUser ? "admin" : "user",
        lastSignedIn: new Date(),
      });

      const sessionToken = await createSessionToken(username, username);
      setSessionCookie(c, sessionToken);

      return c.json({ success: true, role: firstUser ? "admin" : "user" });
    } catch (error: any) {
      console.error("[Auth] Register failed:", error);
      return c.json({ error: "注册失败，请稍后再试" }, 500);
    }
  });

  // Login
  app.post("/api/auth/login", async (c) => {
    try {
      const { username, password } = await c.req.json();
      if (!username || !password) return c.json({ error: "请输入用户名和密码" }, 400);

      const user = await db.getUserByOpenId(username);
      if (!user || !user.passwordHash) return c.json({ error: "用户名或密码错误" }, 401);
      if (user.isBanned) return c.json({ error: "该账号已被禁用，请联系管理员" }, 403);

      const valid = await verifyPassword(password, user.passwordHash);
      if (!valid) return c.json({ error: "用户名或密码错误" }, 401);

      await db.upsertUser({ openId: username, lastSignedIn: new Date() });

      const sessionToken = await createSessionToken(user.openId, user.name || username);
      setSessionCookie(c, sessionToken);

      return c.json({ success: true });
    } catch (error: any) {
      console.error("[Auth] Login failed:", error);
      return c.json({ error: "登录失败，请稍后再试" }, 500);
    }
  });

  // Google OAuth — redirect to consent screen
  app.get("/api/auth/google", (c) => {
    const env = getEnv();
    if (!env.GOOGLE_CLIENT_ID) return c.json({ error: "Google OAuth is not configured" }, 500);

    const proto = c.req.header("x-forwarded-proto") || new URL(c.req.url).protocol.replace(":", "");
    const host = c.req.header("host") || new URL(c.req.url).host;
    const redirectUri = `${proto}://${host}/api/auth/google/callback`;

    const params = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      access_type: "offline",
      prompt: "select_account",
    });
    return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  });

  // Google OAuth callback
  app.get("/api/auth/google/callback", async (c) => {
    try {
      const env = getEnv();
      const code = c.req.query("code");
      if (!code) return c.text("Missing authorization code", 400);

      const proto = c.req.header("x-forwarded-proto") || new URL(c.req.url).protocol.replace(":", "");
      const host = c.req.header("host") || new URL(c.req.url).host;
      const redirectUri = `${proto}://${host}/api/auth/google/callback`;

      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });

      if (!tokenRes.ok) {
        console.error("[Google OAuth] Token exchange failed:", await tokenRes.text());
        return c.text("Google login failed", 500);
      }

      const tokens = (await tokenRes.json()) as { access_token: string };
      const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (!userInfoRes.ok) return c.text("Failed to get user info from Google", 500);

      const googleUser = (await userInfoRes.json()) as {
        id: string; email: string; name: string; picture?: string;
      };

      let user = await db.getUserByEmail(googleUser.email);
      if (!user) user = await db.getUserByOpenId(`google:${googleUser.email}`);
      if (user?.isBanned) return c.text("该账号已被禁用，请联系管理员", 403);

      if (!user) {
        const firstUser = await isFirstUser();
        const openId = `google:${googleUser.email}`;
        await db.upsertUser({
          openId,
          name: googleUser.name || googleUser.email,
          email: googleUser.email,
          loginMethod: "google",
          role: firstUser ? "admin" : "user",
          lastSignedIn: new Date(),
        });
        user = await db.getUserByOpenId(openId);
      } else {
        await db.upsertUser({
          openId: user.openId,
          name: user.name || googleUser.name || googleUser.email,
          email: googleUser.email,
          loginMethod: user.loginMethod === "password" ? "password" : "google",
          lastSignedIn: new Date(),
        });
        user = await db.getUserByOpenId(user.openId);
      }

      if (!user) return c.text("Failed to create user", 500);

      const sessionToken = await createSessionToken(user.openId, user.name || googleUser.email);
      setSessionCookie(c, sessionToken);

      return c.redirect("/");
    } catch (error: any) {
      console.error("[Google OAuth] Callback failed:", error);
      return c.text("Google login failed", 500);
    }
  });

  // Check if Google OAuth is configured
  app.get("/api/auth/google/enabled", (c) => {
    const env = getEnv();
    return c.json({ enabled: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) });
  });
}
