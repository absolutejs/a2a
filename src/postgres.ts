import type {
  A2aOperatorTask,
  A2aTask,
  A2aTaskLabels,
  A2aTaskOperatorStore,
  A2aTaskStore,
} from "./types";

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
  labels jsonb NOT NULL DEFAULT '{}'::jsonb,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ${ns}.tasks ADD COLUMN IF NOT EXISTS labels jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS a2a_tasks_owner_idx ON ${ns}.tasks (authorization_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS a2a_tasks_context_idx ON ${ns}.tasks (authorization_key, context_id);
CREATE INDEX IF NOT EXISTS a2a_tasks_labels_idx ON ${ns}.tasks USING gin (labels);`;
};

type TaskRow = { data: A2aTask | string };
type OperatorTaskRow = TaskRow & { labels: A2aTaskLabels | string };
const taskOf = (row: TaskRow | undefined) => {
  if (!row) return undefined;
  return (
    typeof row.data === "string" ? JSON.parse(row.data) : row.data
  ) as A2aTask;
};

const pageOffset = (token?: string) => {
  if (token === undefined || token === "") return 0;
  try {
    const value = Number.parseInt(atob(token), 10);
    if (Number.isSafeInteger(value) && value >= 0) return value;
  } catch {
    // handled below
  }
  throw new Error("Invalid A2A page token");
};

const visibleTask = (
  task: A2aTask,
  historyLength: number | undefined,
  includeArtifacts: boolean,
) => {
  const visible = structuredClone(task);
  if (!includeArtifacts) delete visible.artifacts;
  if (historyLength !== undefined) {
    visible.history =
      historyLength === 0 ? [] : visible.history?.slice(-historyLength);
  }
  return visible;
};

const labelsOf = (row: OperatorTaskRow) =>
  (typeof row.labels === "string"
    ? JSON.parse(row.labels)
    : row.labels) as A2aTaskLabels;

export const createPostgresA2aTaskStore = ({
  client,
  namespace = "a2a",
}: {
  client: A2aSqlClient;
  namespace?: string;
}): A2aTaskStore & A2aTaskOperatorStore => {
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
    cancelForOperator: async (id, labels, now) => {
      const result = await client.query<OperatorTaskRow>(
        `UPDATE ${ns}.tasks SET state = 'TASK_STATE_CANCELED', data = jsonb_set(jsonb_set(data, '{status,state}', '"TASK_STATE_CANCELED"'::jsonb, true), '{status,timestamp}', to_jsonb($3::text), true), updated_at = $3::timestamptz
         WHERE task_id = $1 AND labels @> $2::jsonb AND state NOT IN ('TASK_STATE_COMPLETED','TASK_STATE_CANCELED','TASK_STATE_FAILED','TASK_STATE_REJECTED') RETURNING labels, data`,
        [id, JSON.stringify(labels), now],
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        labels: labelsOf(row),
        task: visibleTask(taskOf(row) as A2aTask, 0, false),
      };
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
    list: async (authorizationKey, request) => {
      const offset = pageOffset(request.pageToken);
      const pageSize = Math.min(100, Math.max(1, request.pageSize ?? 50));
      if (
        request.statusTimestampAfter !== undefined &&
        !Number.isFinite(Date.parse(request.statusTimestampAfter))
      ) {
        throw new Error("Invalid statusTimestampAfter");
      }
      const values = [
        authorizationKey,
        request.contextId ?? null,
        request.status ?? null,
        request.statusTimestampAfter ?? null,
        pageSize,
        offset,
      ];
      const where = `authorization_key = $1
        AND ($2::text IS NULL OR context_id = $2)
        AND ($3::text IS NULL OR state = $3)
        AND ($4::timestamptz IS NULL OR updated_at >= $4::timestamptz)`;
      const [rows, count] = await Promise.all([
        client.query<TaskRow>(
          `SELECT data FROM ${ns}.tasks WHERE ${where} ORDER BY updated_at DESC LIMIT $5 OFFSET $6`,
          values,
        ),
        client.query<{ count: string | number }>(
          `SELECT count(*)::text AS count FROM ${ns}.tasks WHERE ${where}`,
          values.slice(0, 4),
        ),
      ]);
      const totalSize = Number(count.rows[0]?.count ?? 0);
      const tasks = rows.rows.map((row) =>
        visibleTask(
          taskOf(row) as A2aTask,
          request.historyLength,
          request.includeArtifacts === true,
        ),
      );
      return {
        nextPageToken:
          offset + tasks.length < totalSize
            ? btoa(String(offset + tasks.length))
            : "",
        pageSize,
        tasks,
        totalSize,
      };
    },
    listForOperator: async (request) => {
      const offset = pageOffset(request.pageToken);
      const pageSize = Math.min(100, Math.max(1, request.pageSize ?? 50));
      if (
        request.statusTimestampAfter !== undefined &&
        !Number.isFinite(Date.parse(request.statusTimestampAfter))
      ) {
        throw new Error("Invalid statusTimestampAfter");
      }
      const values = [
        JSON.stringify(request.labels ?? {}),
        request.contextId ?? null,
        request.status ?? null,
        request.statusTimestampAfter ?? null,
        pageSize,
        offset,
      ];
      const where = `labels @> $1::jsonb
        AND ($2::text IS NULL OR context_id = $2)
        AND ($3::text IS NULL OR state = $3)
        AND ($4::timestamptz IS NULL OR updated_at >= $4::timestamptz)`;
      const [rows, count] = await Promise.all([
        client.query<OperatorTaskRow>(
          `SELECT labels, data FROM ${ns}.tasks WHERE ${where} ORDER BY updated_at DESC LIMIT $5 OFFSET $6`,
          values,
        ),
        client.query<{ count: string | number }>(
          `SELECT count(*)::text AS count FROM ${ns}.tasks WHERE ${where}`,
          values.slice(0, 4),
        ),
      ]);
      const totalSize = Number(count.rows[0]?.count ?? 0);
      const items: A2aOperatorTask[] = rows.rows.map((row) => ({
        labels: labelsOf(row),
        task: visibleTask(
          taskOf(row) as A2aTask,
          request.historyLength ?? 0,
          request.includeArtifacts === true,
        ),
      }));
      return {
        items,
        nextPageToken:
          offset + items.length < totalSize
            ? btoa(String(offset + items.length))
            : "",
        pageSize,
        totalSize,
      };
    },
    save: async (task, authorizationKey, labels) => {
      const result = await client.query<{ task_id: string }>(
        `INSERT INTO ${ns}.tasks (task_id, authorization_key, context_id, state, data, labels) VALUES ($1,$2,$3,$4,$5::jsonb,COALESCE($6::jsonb, '{}'::jsonb))
         ON CONFLICT (task_id) DO UPDATE SET context_id = EXCLUDED.context_id, state = EXCLUDED.state, data = EXCLUDED.data, labels = COALESCE($6::jsonb, ${ns}.tasks.labels), updated_at = now()
         WHERE ${ns}.tasks.authorization_key = EXCLUDED.authorization_key
           AND (${ns}.tasks.state NOT IN ('TASK_STATE_COMPLETED','TASK_STATE_CANCELED','TASK_STATE_FAILED','TASK_STATE_REJECTED') OR ${ns}.tasks.data = EXCLUDED.data)
         RETURNING task_id`,
        [
          task.id,
          authorizationKey,
          task.contextId,
          task.status.state,
          JSON.stringify(task),
          labels === undefined ? null : JSON.stringify(labels),
        ],
      );
      if (!result.rows[0])
        throw new Error(
          "A2A task ownership or terminal-state invariant failed",
        );
    },
  };
};
