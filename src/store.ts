import type { A2aTask, A2aTaskStore } from "./types";

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
): A2aTask => ({
  ...task,
  ...(includeArtifacts ? {} : { artifacts: undefined }),
  ...(historyLength === undefined
    ? {}
    : {
        history: historyLength === 0 ? [] : task.history?.slice(-historyLength),
      }),
});

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
    list: async (authorizationKey, request) => {
      const offset = pageOffset(request.pageToken);
      const pageSize = Math.min(100, Math.max(1, request.pageSize ?? 50));
      const timestampAfter =
        request.statusTimestampAfter === undefined
          ? undefined
          : Date.parse(request.statusTimestampAfter);
      if (timestampAfter !== undefined && !Number.isFinite(timestampAfter)) {
        throw new Error("Invalid statusTimestampAfter");
      }
      const filtered = [...rows.values()]
        .filter((row) => row.authorizationKey === authorizationKey)
        .map((row) => row.task)
        .filter(
          (task) =>
            (request.contextId === undefined ||
              task.contextId === request.contextId) &&
            (request.status === undefined ||
              task.status.state === request.status) &&
            (timestampAfter === undefined ||
              (task.status.timestamp !== undefined &&
                Date.parse(task.status.timestamp) >= timestampAfter)),
        )
        .sort((left, right) =>
          (right.status.timestamp ?? "").localeCompare(
            left.status.timestamp ?? "",
          ),
        );
      const tasks = filtered
        .slice(offset, offset + pageSize)
        .map((task) =>
          structuredClone(
            visibleTask(
              task,
              request.historyLength,
              request.includeArtifacts === true,
            ),
          ),
        );
      return {
        nextPageToken:
          offset + tasks.length < filtered.length
            ? btoa(String(offset + tasks.length))
            : "",
        pageSize,
        tasks,
        totalSize: filtered.length,
      };
    },
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
