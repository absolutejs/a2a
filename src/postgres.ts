import type { A2aTask, A2aTaskStore } from "./types";

export type A2aSqlResult<Row> = { rows: Row[] };
export type A2aSqlClient = {
  query: <Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) => Promise<A2aSqlResult<Row>>;
};

const namespaceOf = (namespace: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(namespace)) {
    throw new Error("A2A namespace must be a simple identifier");
  }
  return namespace;
};

export const a2aPostgresSchemaSql = (namespace = "a2a") => {
  const ns = namespaceOf(namespace);
  return `CREATE SCHEMA IF NOT EXISTS ${ns};
CREATE TABLE IF NOT EXISTS ${ns}.tasks (
  task_id text PRIMARY KEY,
  authorization_key text NOT NULL,
  context_id text NOT NULL,
  state text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS a2a_tasks_owner_idx ON ${ns}.tasks (authorization_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS a2a_tasks_context_idx ON ${ns}.tasks (authorization_key, context_id);`;
};

type TaskRow = { data: A2aTask | string };
const taskOf = (row: TaskRow | undefined) => {
  if (!row) return undefined;
  return (
    typeof row.data === "string" ? JSON.parse(row.data) : row.data
  ) as A2aTask;
};

export const createPostgresA2aTaskStore = ({
  client,
  namespace = "a2a",
}: {
  client: A2aSqlClient;
  namespace?: string;
}): A2aTaskStore => {
  const ns = namespaceOf(namespace);
  return {
    cancel: async (id, authorizationKey, now) => {
      const result = await client.query<TaskRow>(
        `UPDATE ${ns}.tasks SET state = 'TASK_STATE_CANCELED', data = jsonb_set(jsonb_set(data, '{status,state}', '"TASK_STATE_CANCELED"'::jsonb, true), '{status,timestamp}', to_jsonb($3::text), true), updated_at = $3::timestamptz
         WHERE task_id = $1 AND authorization_key = $2 AND state NOT IN ('TASK_STATE_COMPLETED','TASK_STATE_CANCELED','TASK_STATE_FAILED','TASK_STATE_REJECTED') RETURNING data`,
        [id, authorizationKey, now],
      );
      return taskOf(result.rows[0]);
    },
    get: async (id, authorizationKey) =>
      taskOf(
        (
          await client.query<TaskRow>(
            `SELECT data FROM ${ns}.tasks WHERE task_id = $1 AND authorization_key = $2`,
            [id, authorizationKey],
          )
        ).rows[0],
      ),
    list: async (authorizationKey) =>
      (
        await client.query<TaskRow>(
          `SELECT data FROM ${ns}.tasks WHERE authorization_key = $1 ORDER BY updated_at DESC`,
          [authorizationKey],
        )
      ).rows.map((row) => taskOf(row) as A2aTask),
    save: async (task, authorizationKey) => {
      const result = await client.query<{ task_id: string }>(
        `INSERT INTO ${ns}.tasks (task_id, authorization_key, context_id, state, data) VALUES ($1,$2,$3,$4,$5::jsonb)
         ON CONFLICT (task_id) DO UPDATE SET context_id = EXCLUDED.context_id, state = EXCLUDED.state, data = EXCLUDED.data, updated_at = now()
         WHERE ${ns}.tasks.authorization_key = EXCLUDED.authorization_key
           AND (${ns}.tasks.state NOT IN ('TASK_STATE_COMPLETED','TASK_STATE_CANCELED','TASK_STATE_FAILED','TASK_STATE_REJECTED') OR ${ns}.tasks.data = EXCLUDED.data)
         RETURNING task_id`,
        [
          task.id,
          authorizationKey,
          task.contextId,
          task.status.state,
          JSON.stringify(task),
        ],
      );
      if (!result.rows[0])
        throw new Error(
          "A2A task ownership or terminal-state invariant failed",
        );
    },
  };
};
