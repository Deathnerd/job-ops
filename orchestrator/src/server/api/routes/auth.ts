import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  serviceUnavailable,
  unauthorized,
} from "@infra/errors";
import { asyncRoute, fail, ok } from "@infra/http";
import { getUserId } from "@infra/request-context";
import { blacklistToken, signToken, verifyToken } from "@server/auth/jwt";
import { verifyPassword } from "@server/auth/password";
import { getJobOpsAppConfig } from "@server/config/app-mode";
import { isDemoMode } from "@server/config/demo";
import * as apiKeysRepo from "@server/repositories/api-keys";
import { getOrCreateAnalyticsInstallState } from "@server/repositories/product-analytics";
import * as usersRepo from "@server/repositories/users";
import type { Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const setupSchema = loginSchema.extend({
  password: z.string().min(8).max(500),
  displayName: z.string().trim().min(1).max(120).optional(),
});

const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(64),
});

function isUsernameConflictError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /UNIQUE constraint failed: users\.username/i.test(error.message);
}

function toSetupValidationMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue?.path.join(".");

  if (path === "password") {
    if (issue?.code === "too_small") {
      return `Password must be at least ${issue.minimum} characters.`;
    }
    if (issue?.code === "too_big") {
      return `Password must be ${issue.maximum} characters or fewer.`;
    }
    return "Enter a valid password.";
  }

  if (path === "username") {
    return "Enter a username.";
  }

  if (path === "displayName") {
    return "Enter a name or leave the field blank.";
  }

  return "Invalid request body";
}

export const authRouter = Router();

authRouter.post(
  "/signup",
  asyncRoute(async (req: Request, res: Response) => {
    if (isDemoMode()) {
      fail(res, serviceUnavailable("Signup is disabled in the public demo."));
      return;
    }

    const appConfig = getJobOpsAppConfig();
    if (appConfig.appMode !== "hosted") {
      fail(res, forbidden("Signup is available only in hosted mode"));
      return;
    }
    if (!appConfig.capabilities.hostedSignups) {
      fail(res, forbidden("Hosted signups are disabled"));
      return;
    }
    if (!appConfig.hostedTenantId) {
      fail(res, serviceUnavailable("Hosted tenant is not configured"));
      return;
    }

    const parsed = setupSchema.safeParse(req.body);
    if (!parsed.success) {
      fail(
        res,
        badRequest(
          toSetupValidationMessage(parsed.error),
          parsed.error.flatten(),
        ),
      );
      return;
    }

    let user: usersRepo.PublicUser | null;
    try {
      user = await usersRepo.createHostedTenantUser({
        username: parsed.data.username,
        password: parsed.data.password,
        displayName: parsed.data.displayName ?? parsed.data.username,
        tenantId: appConfig.hostedTenantId,
      });
    } catch (error) {
      if (isUsernameConflictError(error)) {
        fail(res, conflict("Username already exists"));
        return;
      }
      throw error;
    }

    if (!user) {
      fail(
        res,
        serviceUnavailable("Configured hosted tenant is not available"),
      );
      return;
    }

    const { token, expiresIn } = await signToken({
      sub: user.id,
      userId: user.id,
      tenantId: user.workspaceId,
      username: user.username,
      isSystemAdmin: user.isSystemAdmin,
    });

    ok(res, { token, expiresIn, user }, 201);
  }),
);

authRouter.post(
  "/login",
  asyncRoute(async (req: Request, res: Response) => {
    if ((await usersRepo.countUsers()) === 0) {
      fail(res, badRequest("Initial setup is required before sign-in"));
      return;
    }

    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, badRequest("Invalid request body", parsed.error.flatten()));
      return;
    }

    const { username, password } = parsed.data;
    const user = await usersRepo.getUserForLogin(username);
    if (!user || user.isDisabled) {
      fail(res, unauthorized("Invalid credentials"));
      return;
    }

    const passwordValid = await verifyPassword({
      password,
      passwordHash: user.passwordHash,
      passwordSalt: user.passwordSalt,
    });
    if (!passwordValid) {
      fail(res, unauthorized("Invalid credentials"));
      return;
    }

    let token: string;
    let expiresIn: number;
    try {
      ({ token, expiresIn } = await signToken({
        sub: user.id,
        userId: user.id,
        tenantId: user.tenantId,
        username: user.username,
        isSystemAdmin: user.isSystemAdmin,
      }));
    } catch (error) {
      fail(
        res,
        serviceUnavailable(
          error instanceof Error
            ? error.message
            : "Authentication is not fully configured",
        ),
      );
      return;
    }

    ok(res, { token, expiresIn });
  }),
);

authRouter.get(
  "/bootstrap-status",
  asyncRoute(async (_req: Request, res: Response) => {
    if (isDemoMode() || getJobOpsAppConfig().appMode === "hosted") {
      ok(res, { setupRequired: false });
      return;
    }

    ok(res, { setupRequired: (await usersRepo.countUsers()) === 0 });
  }),
);

authRouter.post(
  "/setup",
  asyncRoute(async (req: Request, res: Response) => {
    if (getJobOpsAppConfig().appMode === "hosted") {
      fail(res, forbidden("First-run setup is disabled in hosted mode"));
      return;
    }

    if (isDemoMode()) {
      fail(
        res,
        serviceUnavailable("First-run setup is disabled in the public demo."),
      );
      return;
    }

    if ((await usersRepo.countUsers()) > 0) {
      fail(res, badRequest("Initial setup has already been completed"));
      return;
    }

    const parsed = setupSchema.safeParse(req.body);
    if (!parsed.success) {
      fail(
        res,
        badRequest(
          toSetupValidationMessage(parsed.error),
          parsed.error.flatten(),
        ),
      );
      return;
    }

    const user = await usersRepo.createInitialSystemAdmin({
      username: parsed.data.username,
      password: parsed.data.password,
      displayName: parsed.data.displayName ?? parsed.data.username,
    });
    if (!user) {
      fail(res, badRequest("Initial setup has already been completed"));
      return;
    }

    const { token, expiresIn } = await signToken({
      sub: user.id,
      userId: user.id,
      tenantId: user.workspaceId,
      username: user.username,
      isSystemAdmin: user.isSystemAdmin,
    });

    ok(res, { token, expiresIn, user }, 201);
  }),
);

authRouter.get(
  "/me",
  asyncRoute(async (_req: Request, res: Response) => {
    // The auth guard (app.ts) already verified the bearer credential -- JWT
    // or API key -- and stashed the resolved identity in the request
    // context. Read it from there instead of re-verifying the token as a
    // JWT, so API-key-authenticated callers work the same as JWT callers.
    const userId = getUserId();
    if (!userId) {
      fail(res, unauthorized("Authentication required"));
      return;
    }
    const user = await usersRepo.getUserById(userId);
    if (!user || user.isDisabled) {
      fail(res, unauthorized("Authentication required"));
      return;
    }
    const installState = await getOrCreateAnalyticsInstallState();
    ok(res, {
      user,
      analyticsDistinctId: installState.distinctId,
    });
  }),
);

authRouter.get(
  "/api-keys",
  asyncRoute(async (_req: Request, res: Response) => {
    const userId = getUserId();
    if (!userId) {
      fail(res, unauthorized("Authentication required"));
      return;
    }
    const keys = await apiKeysRepo.listApiKeys(userId);
    ok(res, { keys });
  }),
);

authRouter.post(
  "/api-keys",
  asyncRoute(async (req: Request, res: Response) => {
    const userId = getUserId();
    if (!userId) {
      fail(res, unauthorized("Authentication required"));
      return;
    }

    const parsed = createApiKeySchema.safeParse(req.body);
    if (!parsed.success) {
      fail(res, badRequest("Invalid request body", parsed.error.flatten()));
      return;
    }

    const created = await apiKeysRepo.createApiKey({
      userId,
      name: parsed.data.name,
    });
    ok(
      res,
      {
        id: created.id,
        name: created.name,
        createdAt: created.createdAt,
        key: created.plaintextKey,
      },
      201,
    );
  }),
);

authRouter.post(
  "/api-keys/:id/revoke",
  asyncRoute(async (req: Request, res: Response) => {
    const userId = getUserId();
    if (!userId) {
      fail(res, unauthorized("Authentication required"));
      return;
    }

    const revoked = await apiKeysRepo.revokeApiKey({
      userId,
      id: req.params.id,
    });
    if (!revoked) {
      fail(res, notFound("API key not found"));
      return;
    }
    ok(res, { revoked: true });
  }),
);

authRouter.post(
  "/logout",
  asyncRoute(async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization || "";
    if (authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice("Bearer ".length).trim();
      try {
        const { jti } = await verifyToken(token);
        await blacklistToken(jti);
      } catch {
        // Token already invalid — logout is idempotent.
      }
    }
    ok(res, { message: "Logged out" });
  }),
);
