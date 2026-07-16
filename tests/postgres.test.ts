import { describe, expect, test } from "bun:test";
import {
  a2aPostgresSchemaSql,
  createPostgresA2aTaskStore,
  type A2aSqlClient,
} from "../src";

describe("A2A PostgreSQL task store", () => {
  test("creates owner and context indexes", () => {
    const sql = a2aPostgresSchemaSql();
    expect(sql).toContain("authorization_key");
    expect(sql).toContain("a2a_tasks_context_idx");
    expect(() => a2aPostgresSchemaSql("bad-name")).toThrow();
  });

  test("cancellation protects terminal states and ownership in SQL", async () => {
    const calls: string[] = [];
    const client: A2aSqlClient = {
      query: async <Row>(text: string) => {
        calls.push(text);
        return { rows: [] as Row[] };
      },
    };
    await createPostgresA2aTaskStore({ client }).cancel(
      "task",
      "owner",
      new Date().toISOString(),
    );
    expect(calls[0]).toContain("authorization_key = $2");
    expect(calls[0]).toContain("state NOT IN");
  });

  test("upserts cannot overwrite another owner or mutate terminal tasks", async () => {
    const calls: string[] = [];
    const client: A2aSqlClient = {
      query: async <Row>(text: string) => {
        calls.push(text);
        return { rows: [{ task_id: "task" } as Row] };
      },
    };
    await createPostgresA2aTaskStore({ client }).save(
      {
        contextId: "context",
        id: "task",
        status: { state: "TASK_STATE_WORKING" },
      },
      "owner",
    );
    expect(calls[0]).toContain(
      "tasks.authorization_key = EXCLUDED.authorization_key",
    );
    expect(calls[0]).toContain("tasks.state NOT IN");
  });
});
