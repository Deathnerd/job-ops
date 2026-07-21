/**
 * Resolves the authenticated identity (user + tenant) for a bearer credential
 * on an incoming request. Shared by the main HTTP auth guard (app.ts) and the
 * MCP mount (server/mcp/index.ts) so both accept the same JWTs and API keys.
 *
 * Lifted verbatim from `createAuthGuard`'s private `getAuthorizationContext`
 * in app.ts (Task 2's hardened fail-closed behavior) -- do not change the
 * control flow here without re-reviewing that history.
 */

import { verifyToken } from "@server/auth/jwt";
import {
  findActiveKeyByHash,
  hashApiKey,
  touchLastUsed,
} from "@server/repositories/api-keys";
import * as usersRepo from "@server/repositories/users";
import type express from "express";

export interface BearerContext {
  userId: string;
  tenantId: string;
  username: string;
  isSystemAdmin: boolean;
}

export async function resolveBearerContext(
  req: express.Request,
): Promise<BearerContext | null> {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  try {
    let payload: Awaited<ReturnType<typeof verifyToken>> | null = null;
    try {
      payload = await verifyToken(token);
    } catch {
      payload = null;
    }
    if (payload) {
      const user = await usersRepo.getUserById(payload.userId);
      if (!user || user.isDisabled || user.workspaceId !== payload.tenantId) {
        return null;
      }
      return {
        userId: user.id,
        tenantId: user.workspaceId,
        username: user.username,
        isSystemAdmin: user.isSystemAdmin,
      };
    }
    // API-key fallback
    const keyRow = await findActiveKeyByHash(hashApiKey(token));
    if (!keyRow) return null;
    const user = await usersRepo.getUserById(keyRow.userId);
    if (!user || user.isDisabled) return null;
    touchLastUsed(keyRow.id);
    return {
      userId: user.id,
      tenantId: user.workspaceId,
      username: user.username,
      isSystemAdmin: user.isSystemAdmin,
    };
  } catch {
    return null;
  }
}
