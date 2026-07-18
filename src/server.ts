import type { ActionRequestInput } from "@absolutejs/agency";
import {
  A2A_AGENT_CARD_PATH,
  A2A_PROTOCOL_VERSION,
  ABSOLUTE_AGENCY_EXTENSION,
  type A2aAgentCard,
  type A2aCancelTaskRequest,
  type A2aGetTaskRequest,
  type A2aListTasksRequest,
  type A2aPushNotificationConfig,
  type A2aRequestContext,
  type A2aSendMessageRequest,
  type A2aServerConfig,
} from "./types";
import { validateA2aPushUrl } from "./push";

const JSON_HEADERS = { "content-type": "application/json" };
const errorResponse = (
  id: unknown,
  code: number,
  message: string,
  data?: unknown,
) =>
  new Response(
    JSON.stringify({
      error: { code, ...(data === undefined ? {} : { data }), message },
      id: id ?? null,
      jsonrpc: "2.0",
    }),
    { headers: JSON_HEADERS },
  );
const resultResponse = (id: unknown, result: unknown) =>
  new Response(JSON.stringify({ id, jsonrpc: "2.0", result }), {
    headers: JSON_HEADERS,
  });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const validMessage = (value: unknown) =>
  isRecord(value) &&
  typeof value.messageId === "string" &&
  (value.role === "ROLE_USER" || value.role === "ROLE_AGENT") &&
  Array.isArray(value.parts) &&
  value.parts.length > 0;

const TERMINAL_TASK_STATES = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_FAILED",
  "TASK_STATE_REJECTED",
]);

const sseResponse = (id: unknown, events: AsyncIterable<unknown>) => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const result of events) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ id, jsonrpc: "2.0", result })}\n\n`,
            ),
          );
        }
        controller.close();
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              error: { code: -32603, message: "Internal error" },
              id,
              jsonrpc: "2.0",
            })}\n\n`,
          ),
        );
        controller.close();
        void error;
      }
    },
  });
  return new Response(stream, {
    headers: {
      "cache-control": "no-cache",
      "content-type": "text/event-stream",
      "x-accel-buffering": "no",
    },
  });
};

class AgencyRequiredError extends Error {
  constructor(
    readonly actionId: string,
    readonly requestable: boolean,
    message: string,
  ) {
    super(message);
  }
}

const defaultAction = <Caller>(
  operation: "SendMessage" | "CancelTask",
  params: unknown,
  context: A2aRequestContext<Caller>,
): ActionRequestInput => ({
  action: `a2a.${operation}`,
  actor: context.actor,
  effects:
    operation === "SendMessage"
      ? ["send", "write", "external-network"]
      : ["write"],
  idempotencyKey:
    operation === "SendMessage" &&
    isRecord(params) &&
    isRecord(params.message) &&
    typeof params.message.messageId === "string"
      ? params.message.messageId
      : undefined,
  input: params,
  resource: {
    id:
      operation === "CancelTask" &&
      isRecord(params) &&
      typeof params.id === "string"
        ? params.id
        : "remote-agent",
    type: operation === "CancelTask" ? "a2a_task" : "a2a_agent",
  },
});

const resumeActionId = (params: unknown) => {
  if (!isRecord(params) || !isRecord(params.metadata)) return undefined;
  const extension = params.metadata[ABSOLUTE_AGENCY_EXTENSION];
  return isRecord(extension) && typeof extension.actionId === "string"
    ? extension.actionId
    : undefined;
};

const withAgency = async <Caller, Result>(
  operation: "SendMessage" | "CancelTask",
  params: unknown,
  context: A2aRequestContext<Caller>,
  config: A2aServerConfig<Caller>,
  run: () => Promise<Result>,
) => {
  const integration = config.agency;
  if (!integration) return run();
  const resumed = resumeActionId(params);
  let actionId = resumed;
  if (!actionId) {
    const requested = await integration.agency.request(
      integration.actionFor?.(operation, params, context) ??
        defaultAction(operation, params, context),
    );
    actionId = requested.action.actionId;
    if (requested.decision.kind !== "allow") {
      throw new AgencyRequiredError(
        actionId,
        requested.decision.requestable,
        requested.decision.reason,
      );
    }
  }
  const lease = await integration.agency.issueLease(actionId);
  return (
    await integration.agency.execute({
      executor: "a2a",
      leaseId: lease.leaseId,
      run,
    })
  ).result;
};

export const withAgencyExtension = (card: A2aAgentCard): A2aAgentCard => ({
  ...card,
  capabilities: {
    ...card.capabilities,
    extensions: [
      ...(card.capabilities.extensions ?? []).filter(
        (extension) => extension.uri !== ABSOLUTE_AGENCY_EXTENSION,
      ),
      {
        description:
          "Returns approval-bound action IDs and accepts them in request metadata after approval.",
        uri: ABSOLUTE_AGENCY_EXTENSION,
      },
    ],
  },
});

export const createA2aHandler = <Caller>(config: A2aServerConfig<Caller>) => {
  const path = config.path ?? "/a2a";
  const card = config.agency
    ? withAgencyExtension(config.agentCard)
    : config.agentCard;
  const cardBody = JSON.stringify(card);
  const etag = `"${card.version}"`;
  const agentInterface = card.supportedInterfaces.find(
    (entry) =>
      entry.protocolBinding === "JSONRPC" &&
      entry.protocolVersion === A2A_PROTOCOL_VERSION,
  );
  if (!agentInterface) {
    throw new Error("Agent Card must advertise an A2A 1.0 JSONRPC interface");
  }
  if (
    card.capabilities.pushNotifications === true &&
    config.pushNotifications === undefined
  ) {
    throw new Error(
      "Agent Card advertises push notifications but no push store is configured",
    );
  }
  if (
    card.capabilities.extendedAgentCard === true &&
    config.extendedAgentCard === undefined
  ) {
    throw new Error(
      "Agent Card advertises an extended card but none is configured",
    );
  }

  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === A2A_AGENT_CARD_PATH) {
      if (request.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304 });
      }
      return new Response(cardBody, {
        headers: {
          "cache-control": "public, max-age=300",
          "content-type": "application/json",
          etag,
        },
      });
    }
    if (url.pathname !== path) return null;
    if (request.method !== "POST") return new Response(null, { status: 405 });

    const auth = await config.authorize(request);
    if (!auth.ok) {
      return new Response(auth.reason ?? "Unauthorized", {
        status: auth.status ?? 401,
      });
    }
    const contentType =
      request.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/json")) {
      return errorResponse(null, -32005, "Content type not supported");
    }
    let body: unknown;
    try {
      const declared = Number(request.headers.get("content-length") ?? "0");
      const maxRequestBytes = config.maxRequestBytes ?? 1_048_576;
      if (declared > maxRequestBytes) {
        return errorResponse(null, -32600, "Request body too large");
      }
      const source = await request.text();
      if (new TextEncoder().encode(source).byteLength > maxRequestBytes) {
        return errorResponse(null, -32600, "Request body too large");
      }
      body = JSON.parse(source);
    } catch {
      return errorResponse(null, -32700, "Invalid JSON payload");
    }
    if (!isRecord(body) || body.jsonrpc !== "2.0" || !("id" in body)) {
      return errorResponse(null, -32600, "Request payload validation error");
    }
    const id = body.id;
    if (request.headers.get("a2a-version") !== A2A_PROTOCOL_VERSION) {
      return errorResponse(id, -32009, "Protocol Version Not Supported", [
        {
          "@type": "a2a.protocol.VersionNotSupported",
          supportedVersions: [A2A_PROTOCOL_VERSION],
        },
      ]);
    }
    const context: A2aRequestContext<Caller> = {
      actor: auth.actor,
      authorizationKey: auth.authorizationKey,
      caller: auth.caller,
      request,
      ...(auth.taskLabels === undefined ? {} : { taskLabels: auth.taskLabels }),
    };
    const requiredExtensions = (card.capabilities.extensions ?? [])
      .filter((extension) => extension.required === true)
      .map((extension) => extension.uri);
    const requestedExtensions = new Set(
      (request.headers.get("a2a-extensions") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    );
    const missingExtension = requiredExtensions.find(
      (extension) => !requestedExtensions.has(extension),
    );
    if (missingExtension !== undefined) {
      return errorResponse(id, -32008, "Required extension not supported", [
        {
          "@type": "a2a.protocol.ExtensionSupportRequired",
          uri: missingExtension,
        },
      ]);
    }
    const params = body.params;
    if (
      agentInterface.tenant !== undefined &&
      (!isRecord(params) || params.tenant !== agentInterface.tenant)
    ) {
      return errorResponse(id, -32602, "Invalid tenant routing parameter");
    }
    try {
      if (body.method === "SendMessage") {
        if (!isRecord(params) || !validMessage(params.message)) {
          return errorResponse(id, -32602, "Invalid parameters");
        }
        const result = await withAgency(
          "SendMessage",
          params,
          context,
          config,
          async () => {
            const sent = await config.sendMessage(
              params as A2aSendMessageRequest,
              context,
            );
            if (sent.task) {
              await config.taskStore.save(
                sent.task,
                context.authorizationKey,
                context.taskLabels,
              );
            }
            return sent;
          },
        );
        return resultResponse(id, result);
      }
      if (body.method === "SendStreamingMessage") {
        if (card.capabilities.streaming !== true) {
          return errorResponse(id, -32004, "Streaming is not supported");
        }
        if (!isRecord(params) || !validMessage(params.message)) {
          return errorResponse(id, -32602, "Invalid parameters");
        }
        const events = config.sendStreamingMessage
          ? config.sendStreamingMessage(
              params as A2aSendMessageRequest,
              context,
            )
          : (async function* () {
              yield await config.sendMessage(
                params as A2aSendMessageRequest,
                context,
              );
            })();
        const persisted = (async function* () {
          for await (const event of events) {
            if ("task" in event) {
              await config.taskStore.save(
                event.task,
                context.authorizationKey,
                context.taskLabels,
              );
            }
            yield event;
          }
        })();
        return sseResponse(id, persisted);
      }
      if (body.method === "GetTask") {
        if (!isRecord(params) || typeof params.id !== "string") {
          return errorResponse(id, -32602, "Invalid parameters");
        }
        const task = await config.taskStore.get(
          (params as A2aGetTaskRequest).id,
          context.authorizationKey,
        );
        const historyLength = (params as A2aGetTaskRequest).historyLength;
        const visibleTask =
          task && historyLength !== undefined && task.history
            ? { ...task, history: task.history.slice(-historyLength) }
            : task;
        return visibleTask
          ? resultResponse(id, visibleTask)
          : errorResponse(id, -32001, "Task not found");
      }
      if (body.method === "ListTasks") {
        if (params !== undefined && !isRecord(params)) {
          return errorResponse(id, -32602, "Invalid parameters");
        }
        try {
          return resultResponse(
            id,
            await config.taskStore.list(
              context.authorizationKey,
              (params ?? {}) as A2aListTasksRequest,
            ),
          );
        } catch {
          return errorResponse(
            id,
            -32602,
            "Invalid task filters or page token",
          );
        }
      }
      if (body.method === "CancelTask") {
        if (!isRecord(params) || typeof params.id !== "string") {
          return errorResponse(id, -32602, "Invalid parameters");
        }
        const task = await withAgency(
          "CancelTask",
          params,
          context,
          config,
          async () =>
            config.cancelTask
              ? config.cancelTask(params as A2aCancelTaskRequest, context)
              : config.taskStore.cancel(
                  params.id as string,
                  context.authorizationKey,
                  new Date().toISOString(),
                ),
        );
        if (!task) return errorResponse(id, -32002, "Task not cancelable");
        if (config.cancelTask) {
          await config.taskStore.save(
            task,
            context.authorizationKey,
            context.taskLabels,
          );
        }
        return resultResponse(id, task);
      }
      if (body.method === "SubscribeToTask") {
        if (card.capabilities.streaming !== true) {
          return errorResponse(id, -32004, "Streaming is not supported");
        }
        if (!isRecord(params) || typeof params.id !== "string") {
          return errorResponse(id, -32602, "Invalid parameters");
        }
        const task = await config.taskStore.get(
          params.id,
          context.authorizationKey,
        );
        if (task === undefined)
          return errorResponse(id, -32001, "Task not found");
        if (TERMINAL_TASK_STATES.has(task.status.state)) {
          return errorResponse(
            id,
            -32004,
            "Cannot subscribe to a terminal task",
          );
        }
        const updates = config.subscribeToTask
          ? config.subscribeToTask(task, context)
          : (async function* () {
              let current = task;
              let previous = JSON.stringify(current);
              yield { task: current } as const;
              while (!TERMINAL_TASK_STATES.has(current.status.state)) {
                await new Promise((resolve) => setTimeout(resolve, 250));
                if (request.signal.aborted) return;
                const next = await config.taskStore.get(
                  current.id,
                  context.authorizationKey,
                );
                if (next === undefined) return;
                const serialized = JSON.stringify(next);
                if (serialized !== previous) {
                  yield { task: next } as const;
                  previous = serialized;
                }
                current = next;
              }
            })();
        const withInitial = config.subscribeToTask
          ? (async function* () {
              yield { task } as const;
              yield* updates;
            })()
          : updates;
        return sseResponse(id, withInitial);
      }
      if (
        body.method === "CreateTaskPushNotificationConfig" ||
        body.method === "GetTaskPushNotificationConfig" ||
        body.method === "ListTaskPushNotificationConfigs" ||
        body.method === "DeleteTaskPushNotificationConfig"
      ) {
        if (
          card.capabilities.pushNotifications !== true ||
          config.pushNotifications === undefined
        ) {
          return errorResponse(
            id,
            -32003,
            "Push notifications are not supported",
          );
        }
        if (!isRecord(params) || typeof params.taskId !== "string") {
          return errorResponse(id, -32602, "Invalid parameters");
        }
        const ownedTask = await config.taskStore.get(
          params.taskId,
          context.authorizationKey,
        );
        if (ownedTask === undefined)
          return errorResponse(id, -32001, "Task not found");
        const store = config.pushNotifications.store;
        if (body.method === "CreateTaskPushNotificationConfig") {
          if (typeof params.url !== "string") {
            return errorResponse(id, -32602, "Push URL is required");
          }
          let pushUrl: string;
          try {
            pushUrl = validateA2aPushUrl(params.url);
          } catch {
            return errorResponse(id, -32602, "Invalid push URL");
          }
          const created = await store.create(
            {
              ...(params as A2aPushNotificationConfig),
              taskId: params.taskId,
              url: pushUrl,
            },
            context.authorizationKey,
          );
          return resultResponse(id, created);
        }
        if (body.method === "ListTaskPushNotificationConfigs") {
          const configs = await store.list(
            params.taskId,
            context.authorizationKey,
          );
          const pageSize = Math.min(
            100,
            Math.max(
              1,
              typeof params.pageSize === "number" ? params.pageSize : 50,
            ),
          );
          let offset = 0;
          if (typeof params.pageToken === "string" && params.pageToken !== "") {
            try {
              offset = Number.parseInt(atob(params.pageToken), 10);
            } catch {
              offset = -1;
            }
            if (!Number.isSafeInteger(offset) || offset < 0) {
              return errorResponse(id, -32602, "Invalid page token");
            }
          }
          const page = configs.slice(offset, offset + pageSize);
          return resultResponse(id, {
            configs: page,
            nextPageToken:
              offset + page.length < configs.length
                ? btoa(String(offset + page.length))
                : "",
          });
        }
        if (typeof params.id !== "string") {
          return errorResponse(id, -32602, "Configuration id is required");
        }
        if (body.method === "GetTaskPushNotificationConfig") {
          const found = await store.get(
            params.taskId,
            params.id,
            context.authorizationKey,
          );
          return found
            ? resultResponse(id, found)
            : errorResponse(id, -32001, "Push configuration not found");
        }
        const deleted = await store.delete(
          params.taskId,
          params.id,
          context.authorizationKey,
        );
        return deleted
          ? resultResponse(id, {})
          : errorResponse(id, -32001, "Push configuration not found");
      }
      if (body.method === "GetExtendedAgentCard") {
        if (
          card.capabilities.extendedAgentCard !== true ||
          config.extendedAgentCard === undefined
        ) {
          return errorResponse(
            id,
            -32007,
            "Extended Agent Card is not configured",
          );
        }
        const extended =
          typeof config.extendedAgentCard === "function"
            ? await config.extendedAgentCard(context)
            : config.extendedAgentCard;
        return resultResponse(id, extended);
      }
      return errorResponse(id, -32601, "Method not found");
    } catch (error) {
      if (error instanceof AgencyRequiredError) {
        return errorResponse(id, -32010, "Agency authorization required", [
          {
            "@type": ABSOLUTE_AGENCY_EXTENSION,
            actionId: error.actionId,
            reason: error.message,
            requestable: error.requestable,
          },
        ]);
      }
      return errorResponse(id, -32603, "Internal error");
    }
  };
};
