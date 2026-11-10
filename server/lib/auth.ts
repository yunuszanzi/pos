import { createClient } from "@supabase/supabase-js";
import { and, eq } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { appUsers, authSessions, businessSettings, userBranches, terminals } from "../../db/schema";
import { db } from "./db";
import type { Principal } from "./permissions";
import { getRolePermissions, principalKey } from "./permissions";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

function getPinSecret(): string {
  const secret = required("PIN_SESSION_SECRET");
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("PIN_SESSION_SECRET must contain at least 32 bytes");
  }
  return secret;
}

export function createPinRateKey(input: string): string {
  return createHmac("sha256", getPinSecret()).update(input).digest("hex");
}

const authClient = createClient(required("SUPABASE_URL"), required("SUPABASE_ANON_KEY"), {
  auth: { autoRefreshToken: false, persistSession: false },
});

type PinSession = {
  baseUserId: string;
  activeUserId: string;
  businessId: string;
  terminalId: string;
  expiresAt: number;
};

function signPayload(payload: PinSession): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", getPinSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyPayload(token: string): PinSession | null {
  const [encoded, suppliedSignature] = token.split(".");
  if (!encoded || !suppliedSignature) return null;
  const expected = createHmac("sha256", getPinSecret()).update(encoded).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(suppliedSignature, "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as PinSession;
    if (payload.expiresAt <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function getVerifiedSessionId(token: string): string | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { session_id?: unknown };
    return typeof claims.session_id === "string" ? claims.session_id : null;
  } catch {
    return null;
  }
}

export const authenticate: MiddlewareHandler = async (context, next) => {
  const authorization = context.req.header("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return context.json({ error: { code: "UNAUTHENTICATED", message: "Sign in to continue" } }, 401);
  }
  const token = authorization.slice("Bearer ".length);
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data.user) {
    return context.json({ error: { code: "UNAUTHENTICATED", message: "Your session is invalid or expired" } }, 401);
  }

  const [userProfile] = await db.select()
    .from(appUsers)
    .where(eq(appUsers.id, data.user.id))
    .limit(1);
  if (userProfile && !userProfile.active) {
    return context.json({ error: { code: "USER_INACTIVE", message: "This account has been deactivated" } }, 403);
  }
  const user = userProfile ?? null;

  const principal: Principal = {
    authUserId: data.user.id,
    authEmail: data.user.email ?? null,
    userId: user?.id ?? null,
    businessId: user?.businessId ?? null,
    roleId: user?.roleId ?? null,
    activeUserId: user?.id ?? null,
    activeUserName: user?.displayName ?? null,
    activeUserEmail: user?.email ?? null,
    terminalId: null,
    permissions: user ? await getRolePermissions(user.roleId) : new Set(),
  };

  const terminalId = context.req.header("X-Terminal-Id");
  if (user) {
    const sessionId = getVerifiedSessionId(token);
    if (!sessionId) {
      return context.json({ error: { code: "UNAUTHENTICATED", message: "The authentication token has no session identity" } }, 401);
    }
    if (terminalId) {
      const [terminal] = await db.select().from(terminals)
        .where(and(eq(terminals.id, terminalId), eq(terminals.businessId, user.businessId), eq(terminals.active, true)))
        .limit(1);
      if (!terminal) return context.json({ error: { code: "TERMINAL_NOT_FOUND", message: "Terminal is not part of this business" } }, 403);
      if (!principal.permissions.has("*")) {
        const [branchGrant] = await db.select().from(userBranches)
          .where(and(eq(userBranches.userId, user.id), eq(userBranches.branchId, terminal.branchId))).limit(1);
        if (!branchGrant) return context.json({ error: { code: "BRANCH_ACCESS_DENIED", message: "You are not assigned to this terminal branch" } }, 403);
      }
      principal.terminalId = terminal.id;
    }
    const [settings] = await db.select().from(businessSettings)
      .where(eq(businessSettings.businessId, user.businessId)).limit(1);
    const inactivityLimit = terminalId
      ? (settings?.posSessionTimeoutHours ?? 12) * 60 * 60 * 1000
      : (settings?.sessionTimeoutMinutes ?? 30) * 60 * 1000;
    const [session] = await db.select().from(authSessions).where(eq(authSessions.sessionId, sessionId)).limit(1);
    if (session && session.userId !== user.id) {
      return context.json({ error: { code: "UNAUTHENTICATED", message: "The authentication session is invalid" } }, 401);
    }
    if (session && Date.now() - session.lastActivityAt.getTime() > inactivityLimit) {
      await db.delete(authSessions).where(eq(authSessions.sessionId, sessionId));
      return context.json({ error: { code: "SESSION_INACTIVE", message: "Your session expired due to inactivity. Please sign in again." } }, 401);
    }
    await db.insert(authSessions).values({ sessionId, userId: user.id, lastActivityAt: new Date() })
      .onConflictDoUpdate({ target: authSessions.sessionId, set: { lastActivityAt: new Date() } });
  }

  const pinToken = context.req.header("X-PIN-Session");
  if (pinToken) {
    const switched = verifyPayload(pinToken);
    if (!switched || switched.baseUserId !== data.user.id || switched.terminalId !== terminalId) {
      return context.json({ error: { code: "INVALID_TERMINAL_SESSION", message: "Switch users again to continue" } }, 401);
    }
    const [activeUser] = await db.select()
      .from(appUsers)
      .where(and(eq(appUsers.id, switched.activeUserId), eq(appUsers.businessId, switched.businessId), eq(appUsers.active, true)))
      .limit(1);
    const [terminal] = await db.select()
      .from(terminals)
      .where(and(eq(terminals.id, switched.terminalId), eq(terminals.businessId, switched.businessId), eq(terminals.active, true)))
      .limit(1);
    const [branchGrant] = activeUser
      ? await db.select().from(userBranches)
        .where(and(eq(userBranches.userId, activeUser.id), eq(userBranches.branchId, terminal?.branchId ?? "")))
        .limit(1)
      : [];
    if (!activeUser || !terminal || !branchGrant) {
      return context.json({ error: { code: "INVALID_TERMINAL_SESSION", message: "This user is not assigned to the terminal branch" } }, 403);
    }
    principal.userId = activeUser.id;
    principal.activeUserId = activeUser.id;
    principal.activeUserName = activeUser.displayName;
    principal.activeUserEmail = activeUser.email;
    principal.businessId = activeUser.businessId;
    principal.roleId = activeUser.roleId;
    principal.permissions = await getRolePermissions(activeUser.roleId);
    principal.terminalId = terminal.id;
  }

  context.set(principalKey, principal);
  await next();
};

export function createPinSession(payload: Omit<PinSession, "expiresAt">): string {
  return signPayload({ ...payload, expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
}

export async function verifySupabaseToken(token: string) {
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}
