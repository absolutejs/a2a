import type { ActionRequestInput } from "@absolutejs/agency";
import {
  A2A_AGENT_CARD_PATH,
  A2A_PROTOCOL_VERSION,
  ABSOLUTE_AGENCY_EXTENSION,
  type A2aAgentCard,
  type A2aCancelTaskRequest,
  type A2aGetTaskRequest,
  type A2aRequestContext,
  type A2aSendMessageRequest,
  type A2aServerConfig,
} from "./types";

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
    let body: unknown;
    try {
      body = await request.json();
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
    };
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
              await config.taskStore.save(sent.task, context.authorizationKey);
            }
            return sent;
          },
        );
        return resultResponse(id, result);
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
          ? resultResponse(id, { task: visibleTask })
          : errorResponse(id, -32001, "Task not found");
      }
      if (body.method === "ListTasks") {
        return resultResponse(id, {
          tasks: await config.taskStore.list(context.authorizationKey),
        });
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
          await config.taskStore.save(task, context.authorizationKey);
        }
        return resultResponse(id, { task });
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
