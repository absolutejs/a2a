import type { A2aTask, A2aTaskStore } from "./types";

const terminal = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_FAILED",
  "TASK_STATE_REJECTED",
]);

export const createMemoryA2aTaskStore = (): A2aTaskStore => {
  const rows = new Map<string, { authorizationKey: string; task: A2aTask }>();
  return {
    cancel: async (id, authorizationKey, now) => {
      const row = rows.get(id);
      if (!row || row.authorizationKey !== authorizationKey) return undefined;
      if (terminal.has(row.task.status.state)) return undefined;
      const task: A2aTask = {
        ...row.task,
        status: { state: "TASK_STATE_CANCELED", timestamp: now },
      };
      rows.set(id, { authorizationKey, task: structuredClone(task) });
      return structuredClone(task);
    },
    get: async (id, authorizationKey) => {
      const row = rows.get(id);
      return row?.authorizationKey === authorizationKey
        ? structuredClone(row.task)
        : undefined;
    },
    list: async (authorizationKey) =>
      [...rows.values()]
        .filter((row) => row.authorizationKey === authorizationKey)
        .map((row) => structuredClone(row.task)),
    save: async (task, authorizationKey) => {
      const existing = rows.get(task.id);
      if (existing && existing.authorizationKey !== authorizationKey) {
        throw new Error("A2A task ownership cannot be changed");
      }
      if (
        existing &&
        terminal.has(existing.task.status.state) &&
        JSON.stringify(existing.task) !== JSON.stringify(task)
      ) {
        throw new Error("A2A terminal task cannot be changed");
      }
      rows.set(task.id, { authorizationKey, task: structuredClone(task) });
    },
  };
};
