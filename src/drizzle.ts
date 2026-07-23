import { and, count, desc, eq, gte, notInArray, or, sql } from "drizzle-orm";
import {
  customType,
  index,
  pgSchema,
  text,
  timestamp,
  type PgAsyncDatabase,
} from "drizzle-orm/pg-core";
import type {
  A2aOperatorTask,
  A2aTask,
  A2aTaskLabels,
  A2aTaskOperatorStore,
  A2aTaskStore,
  A2aTaskState,
} from "./types";

type AnyPgDatabase = PgAsyncDatabase<any, any>;
const portableJsonb = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => "jsonb",
  fromDriver: (value) =>
    typeof value === "string" ? JSON.parse(value) : value,
  toDriver: (value) => JSON.stringify(value),
});
const encodedJsonb = <Value>(value: Value) =>
  sql<Value>`${JSON.stringify(value)}::text::jsonb`;
const terminalStates: A2aTaskState[] = [
  "TASK_STATE_COMPLETED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_FAILED",
  "TASK_STATE_REJECTED",
];

const namespaceOf = (namespace: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(namespace))
    throw new Error("A2A namespace must be a simple identifier");
  return namespace;
};
const pageOffset = (token?: string) => {
  if (token === undefined || token === "") return 0;
  try {
    const value = Number.parseInt(atob(token), 10);
    if (Number.isSafeInteger(value) && value >= 0) return value;
  } catch {}
  throw new Error("Invalid A2A page token");
};
const visibleTask = (
  task: A2aTask,
  historyLength: number | undefined,
  includeArtifacts: boolean,
) => {
  const visible = structuredClone(task);
  if (!includeArtifacts) delete visible.artifacts;
  if (historyLength !== undefined)
    visible.history =
      historyLength === 0 ? [] : visible.history?.slice(-historyLength);
  return visible;
};
const cancelled = (task: A2aTask, now: string) => ({
  ...structuredClone(task),
  status: {
    ...task.status,
    state: "TASK_STATE_CANCELED" as const,
    timestamp: now,
  },
});

export const a2aDrizzleSchema = (namespace = "a2a") => {
  const schema = pgSchema(namespaceOf(namespace));
  const tasks = schema.table(
    "tasks",
    {
      authorization_key: text().notNull(),
      context_id: text().notNull(),
      created_at: timestamp({ mode: "date", withTimezone: true })
        .notNull()
        .defaultNow(),
      data: portableJsonb().$type<A2aTask>().notNull(),
      labels: portableJsonb().$type<A2aTaskLabels>().notNull().default({}),
      state: text().$type<A2aTaskState>().notNull(),
      task_id: text().primaryKey(),
      updated_at: timestamp({ mode: "date", withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (table) => [
      index("a2a_tasks_owner_idx").on(
        table.authorization_key,
        table.updated_at.desc(),
      ),
      index("a2a_tasks_context_idx").on(
        table.authorization_key,
        table.context_id,
      ),
      index("a2a_tasks_labels_idx").using("gin", table.labels),
    ],
  );
  return { tasks };
};

export const createDrizzleA2aTaskStore = <DB extends AnyPgDatabase>(
  db: DB,
  options: { namespace?: string } = {},
): A2aTaskStore & A2aTaskOperatorStore => {
  const { tasks } = a2aDrizzleSchema(options.namespace);
  const labelContains = (labels: A2aTaskLabels) =>
    sql<boolean>`${tasks.labels} @> ${JSON.stringify(labels)}::text::jsonb`;
  const listWhere = (input: {
    authorizationKey?: string;
    contextId?: string;
    labels?: A2aTaskLabels;
    status?: A2aTaskState;
    statusTimestampAfter?: string;
  }) =>
    and(
      input.authorizationKey
        ? eq(tasks.authorization_key, input.authorizationKey)
        : undefined,
      input.labels ? labelContains(input.labels) : undefined,
      input.contextId ? eq(tasks.context_id, input.contextId) : undefined,
      input.status ? eq(tasks.state, input.status) : undefined,
      input.statusTimestampAfter
        ? gte(tasks.updated_at, new Date(input.statusTimestampAfter))
        : undefined,
    );
  const updateCancel = async (
    database: AnyPgDatabase,
    where: ReturnType<typeof and>,
    now: string,
  ) => {
    const prior = (
      await database
        .select({ data: tasks.data, labels: tasks.labels })
        .from(tasks)
        .where(and(where, notInArray(tasks.state, terminalStates)))
        .for("update")
        .limit(1)
    )[0];
    if (!prior) return undefined;
    const data = cancelled(prior.data, now);
    await database
      .update(tasks)
      .set({
        data: encodedJsonb(data),
        state: data.status.state,
        updated_at: new Date(now),
      })
      .where(eq(tasks.task_id, data.id));
    return { data, labels: prior.labels };
  };

  return {
    cancel: (id, authorizationKey, now) =>
      db.transaction(
        async (transaction) =>
          (
            await updateCancel(
              transaction,
              and(
                eq(tasks.task_id, id),
                eq(tasks.authorization_key, authorizationKey),
              ),
              now,
            )
          )?.data,
      ),
    cancelForOperator: (id, labels, now) =>
      db.transaction(async (transaction) => {
        const row = await updateCancel(
          transaction,
          and(eq(tasks.task_id, id), labelContains(labels)),
          now,
        );
        return row
          ? { labels: row.labels, task: visibleTask(row.data, 0, false) }
          : undefined;
      }),
    get: async (id, authorizationKey) =>
      (
        await db
          .select({ data: tasks.data })
          .from(tasks)
          .where(
            and(
              eq(tasks.task_id, id),
              eq(tasks.authorization_key, authorizationKey),
            ),
          )
          .limit(1)
      )[0]?.data,
    list: async (authorizationKey, request) => {
      const offset = pageOffset(request.pageToken);
      const pageSize = Math.min(100, Math.max(1, request.pageSize ?? 50));
      if (
        request.statusTimestampAfter !== undefined &&
        !Number.isFinite(Date.parse(request.statusTimestampAfter))
      )
        throw new Error("Invalid statusTimestampAfter");
      const where = listWhere({
        authorizationKey,
        ...(request.contextId ? { contextId: request.contextId } : {}),
        ...(request.status ? { status: request.status } : {}),
        ...(request.statusTimestampAfter
          ? { statusTimestampAfter: request.statusTimestampAfter }
          : {}),
      });
      const [rows, totals] = await Promise.all([
        db
          .select({ data: tasks.data })
          .from(tasks)
          .where(where)
          .orderBy(desc(tasks.updated_at))
          .limit(pageSize)
          .offset(offset),
        db.select({ value: count() }).from(tasks).where(where),
      ]);
      const totalSize = totals[0]?.value ?? 0;
      const visible = rows.map(({ data }) =>
        visibleTask(
          data,
          request.historyLength,
          request.includeArtifacts === true,
        ),
      );
      return {
        nextPageToken:
          offset + visible.length < totalSize
            ? btoa(String(offset + visible.length))
            : "",
        pageSize,
        tasks: visible,
        totalSize,
      };
    },
    listForOperator: async (request) => {
      const offset = pageOffset(request.pageToken);
      const pageSize = Math.min(100, Math.max(1, request.pageSize ?? 50));
      if (
        request.statusTimestampAfter !== undefined &&
        !Number.isFinite(Date.parse(request.statusTimestampAfter))
      )
        throw new Error("Invalid statusTimestampAfter");
      const where = listWhere({
        labels: request.labels ?? {},
        ...(request.contextId ? { contextId: request.contextId } : {}),
        ...(request.status ? { status: request.status } : {}),
        ...(request.statusTimestampAfter
          ? { statusTimestampAfter: request.statusTimestampAfter }
          : {}),
      });
      const [rows, totals] = await Promise.all([
        db
          .select({ data: tasks.data, labels: tasks.labels })
          .from(tasks)
          .where(where)
          .orderBy(desc(tasks.updated_at))
          .limit(pageSize)
          .offset(offset),
        db.select({ value: count() }).from(tasks).where(where),
      ]);
      const totalSize = totals[0]?.value ?? 0;
      const items: A2aOperatorTask[] = rows.map(({ data, labels }) => ({
        labels,
        task: visibleTask(
          data,
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
      const result = await db
        .insert(tasks)
        .values({
          authorization_key: authorizationKey,
          context_id: task.contextId,
          data: encodedJsonb(task),
          labels: encodedJsonb(labels ?? {}),
          state: task.status.state,
          task_id: task.id,
        })
        .onConflictDoUpdate({
          target: tasks.task_id,
          set: {
            context_id: task.contextId,
            data: encodedJsonb(task),
            labels:
              labels === undefined
                ? sql`${tasks.labels}`
                : encodedJsonb(labels),
            state: task.status.state,
            updated_at: new Date(),
          },
          setWhere: and(
            eq(tasks.authorization_key, authorizationKey),
            or(
              notInArray(tasks.state, terminalStates),
              eq(tasks.data, encodedJsonb(task)),
            ),
          ),
        })
        .returning({ id: tasks.task_id });
      if (result.length === 0)
        throw new Error(
          "A2A task ownership or terminal-state invariant failed",
        );
    },
  };
};
