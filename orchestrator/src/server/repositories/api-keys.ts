import { createHash, randomUUID } from "node:crypto";
import { createId } from "@paralleldrive/cuid2";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/index";

const { apiKeys } = schema;

const TOUCH_THROTTLE_MS = 60_000;
const lastTouchedAt = new Map<string, number>();

export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

export async function createApiKey(input: {
  userId: string;
  name: string;
}): Promise<{
  id: string;
  name: string;
  plaintextKey: string;
  createdAt: string;
}> {
  const plaintextKey = randomUUID();
  const id = createId();
  const createdAt = new Date().toISOString();

  await db.insert(apiKeys).values({
    id,
    userId: input.userId,
    name: input.name,
    keyHash: hashApiKey(plaintextKey),
    createdAt,
  });

  return { id, name: input.name, plaintextKey, createdAt };
}

export async function findActiveKeyByHash(
  keyHash: string,
): Promise<{ id: string; userId: string } | null> {
  const [row] = await db
    .select({ id: apiKeys.id, userId: apiKeys.userId })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)));

  return row ?? null;
}

export async function listApiKeys(userId: string): Promise<
  Array<{
    id: string;
    name: string;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
  }>
> {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      createdAt: apiKeys.createdAt,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId));
}

export async function revokeApiKey(input: {
  userId: string;
  id: string;
}): Promise<boolean> {
  const result = await db
    .update(apiKeys)
    .set({ revokedAt: new Date().toISOString() })
    .where(
      and(
        eq(apiKeys.id, input.id),
        eq(apiKeys.userId, input.userId),
        isNull(apiKeys.revokedAt),
      ),
    );

  return result.changes > 0;
}

export function touchLastUsed(id: string): void {
  const now = Date.now();
  const previous = lastTouchedAt.get(id) ?? 0;
  if (now - previous < TOUCH_THROTTLE_MS) return;
  lastTouchedAt.set(id, now);

  void db
    .update(apiKeys)
    .set({ lastUsedAt: new Date().toISOString() })
    .where(eq(apiKeys.id, id));
}
