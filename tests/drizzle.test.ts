import { expect, test } from "bun:test";
import { SQL } from "bun";
import { sql as expression } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { createDrizzleA2aTaskStore } from "../src";

const databaseUrl = process.env.DATABASE_URL;

test.skipIf(!databaseUrl)(
  "Drizzle tasks preserve JSONB label fences",
  async () => {
    const client = new SQL(databaseUrl!);
    const db = drizzle({ client });
    const rollback = new Error("expected rollback");
    try {
      await db.transaction(async (transaction) => {
        const suffix = crypto.randomUUID();
        const now = new Date().toISOString();
        const tenantId = `tenant-${suffix}`;
        const store = createDrizzleA2aTaskStore(transaction);
        const task = {
          contextId: `context-${suffix}`,
          id: `task-${suffix}`,
          status: { state: "TASK_STATE_SUBMITTED" as const, timestamp: now },
        };
        await store.save(task, `owner-${suffix}`, { tenantId });
        const [shape] = await transaction.execute(
          expression<{
            kind: string;
          }>`select jsonb_typeof(labels) as kind from a2a.tasks where task_id = ${task.id}`,
        );
        expect(shape?.kind).toBe("object");
        expect(
          (await store.listForOperator({ labels: { tenantId }, pageSize: 10 }))
            .items,
        ).toHaveLength(1);
        expect(
          (await store.cancelForOperator(task.id, { tenantId }, now))?.task
            .status.state,
        ).toBe("TASK_STATE_CANCELED");
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      await client.close();
    }
  },
);
