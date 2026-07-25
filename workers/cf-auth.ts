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
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { SignJWT, jwtVerify } from "jose";
import { createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import * as db from "../server/db";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import type { User } from "../drizzle/schema";

// ─── Env access ───
function getEnv() {
  return (globalThis as any).__CF_ENV__ || {};
}

// ─── Password Hashing ───
// Workers supports the full node:crypto API with nodejs_compat. Keep the same
// scrypt format as Cloud Run so existing password accounts work on both hosts.

const scryptAsync = promisify(scrypt);
const EMAIL_LOGIN_COOKIE = "geo_email_login";
const EMAIL_LOGIN_TTL_SECONDS = 10 * 60;

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scryptAsync(plain, salt, 64)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  const [salt, key] = hash.split(":");
  if (!salt || !key) return false;
  const derived = (await scryptAsync(plain, salt, 64)) as Buffer;
  const keyBuffer = Buffer.from(key, "hex");
  if (derived.length !== keyBuffer.length) return false;
  return timingSafeEqual(derived, keyBuffer);
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

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function emailCodeDigest(secret: string, nonce: string, email: string, code: string): string {
  return createHmac("sha256", secret)
    .update(`${nonce}:${email}:${code}`)
    .digest("hex");
}

async function createEmailChallenge(email: string, code: string) {
  const env = getEnv();
  const nonce = randomBytes(16).toString("hex");
  const digest = emailCodeDigest(env.JWT_SECRET, nonce, email, code);
  const token = await new SignJWT({
    kind: "email-login",
    email,
    nonce,
    digest,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime(`${EMAIL_LOGIN_TTL_SECONDS}s`)
    .sign(getSessionSecret());
  return token;
}

async function verifyEmailChallenge(
  token: string | undefined,
  email: string,
  code: string,
): Promise<boolean> {
  if (!token) return false;
  try {
    const { payload } = await jwtVerify(token, getSessionSecret(), {
      algorithms: ["HS256"],
    });
    if (
      payload.kind !== "email-login" ||
      payload.email !== email ||
      typeof payload.nonce !== "string" ||
      typeof payload.digest !== "string"
    ) {
      return false;
    }
    const expected = emailCodeDigest(
      getEnv().JWT_SECRET,
      payload.nonce,
      email,
      code,
    );
    const actualBuffer = Buffer.from(payload.digest, "hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    return (
      actualBuffer.length === expectedBuffer.length &&
      timingSafeEqual(actualBuffer, expectedBuffer)
    );
  } catch {
    return false;
  }
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

  // Passwordless email login via Resend. In production AUTH_ALLOWED_EMAIL keeps
  // the onboarding sender locked to the Resend account owner's mailbox.
  app.get("/api/auth/email/enabled", (c) => {
    const env = getEnv();
    return c.json({
      enabled: Boolean(env.RESEND_API_KEY && env.AUTH_ALLOWED_EMAIL),
    });
  });

  app.post("/api/auth/email/send-code", async (c) => {
    try {
      const env = getEnv();
      if (!env.RESEND_API_KEY || !env.AUTH_ALLOWED_EMAIL) {
        return c.json({ error: "邮箱验证码登录尚未配置" }, 503);
      }
      const input = await c.req.json();
      const email = normalizeEmail(String(input?.email || ""));
      const allowedEmail = normalizeEmail(env.AUTH_ALLOWED_EMAIL);
      if (!isValidEmail(email)) return c.json({ error: "请输入有效的邮箱地址" }, 400);
      if (email !== allowedEmail) return c.json({ error: "该邮箱暂未获准登录" }, 403);

      const code = String(randomInt(100000, 1000000));
      const challenge = await createEmailChallenge(email, code);
      const from = env.RESEND_FROM || "GEO+SEO 系统 <onboarding@resend.dev>";
      const sendResponse = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [email],
          subject: "GEO+SEO 系统登录验证码",
          html: `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:520px;margin:0 auto;padding:24px">
            <h2 style="margin:0 0 16px">GEO+SEO 系统登录</h2>
            <p style="color:#4b5563">你的登录验证码是：</p>
            <div style="font-size:32px;font-weight:700;letter-spacing:8px;padding:18px 0">${code}</div>
            <p style="color:#6b7280;font-size:13px">验证码 10 分钟内有效。如果不是你本人操作，请忽略本邮件。</p>
          </div>`,
        }),
      });
      if (!sendResponse.ok) {
        console.error("[Email Auth] Resend failed:", await sendResponse.text());
        return c.json({ error: "验证码发送失败，请稍后再试" }, 502);
      }

      setCookie(c, EMAIL_LOGIN_COOKIE, challenge, {
        httpOnly: true,
        path: "/",
        sameSite: "Strict",
        secure: isSecureRequest(c),
        maxAge: EMAIL_LOGIN_TTL_SECONDS,
      });
      return c.json({ success: true, expiresIn: EMAIL_LOGIN_TTL_SECONDS });
    } catch (error) {
      console.error("[Email Auth] Send code failed:", error);
      return c.json({ error: "验证码发送失败，请稍后再试" }, 500);
    }
  });

  app.post("/api/auth/email/verify", async (c) => {
    try {
      const env = getEnv();
      const input = await c.req.json();
      const email = normalizeEmail(String(input?.email || ""));
      const code = String(input?.code || "").trim();
      if (!/^\d{6}$/.test(code)) return c.json({ error: "请输入 6 位验证码" }, 400);
      if (email !== normalizeEmail(env.AUTH_ALLOWED_EMAIL || "")) {
        return c.json({ error: "该邮箱暂未获准登录" }, 403);
      }
      const valid = await verifyEmailChallenge(
        getCookie(c, EMAIL_LOGIN_COOKIE),
        email,
        code,
      );
      if (!valid) return c.json({ error: "验证码无效或已过期" }, 401);

      let user = await db.getUserByEmail(email);
      if (!user) user = await db.getUserByOpenId(`email:${email}`);
      if (user?.isBanned) return c.json({ error: "该账号已被禁用，请联系管理员" }, 403);
      if (!user) {
        const firstUser = await isFirstUser();
        await db.upsertUser({
          openId: `email:${email}`,
          name: email,
          email,
          loginMethod: "email",
          role: firstUser ? "admin" : "user",
          lastSignedIn: new Date(),
        });
        user = await db.getUserByOpenId(`email:${email}`);
      } else {
        await db.upsertUser({
          openId: user.openId,
          email,
          lastSignedIn: new Date(),
        });
        user = await db.getUserByOpenId(user.openId);
      }
      if (!user) return c.json({ error: "登录账号创建失败" }, 500);

      setSessionCookie(c, await createSessionToken(user.openId, user.name || email));
      deleteCookie(c, EMAIL_LOGIN_COOKIE, {
        path: "/",
        sameSite: "Strict",
        secure: isSecureRequest(c),
      });
      return c.json({ success: true });
    } catch (error) {
      console.error("[Email Auth] Verify failed:", error);
      return c.json({ error: "邮箱登录失败，请稍后再试" }, 500);
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
