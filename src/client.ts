import {
  A2A_AGENT_CARD_PATH,
  A2A_PROTOCOL_VERSION,
  type A2aAgentCard,
  type A2aCancelTaskRequest,
  type A2aGetTaskRequest,
  type A2aListTasksRequest,
  type A2aListTasksResponse,
  type A2aPushNotificationConfig,
  type A2aSendMessageRequest,
  type A2aSendMessageResponse,
  type A2aTask,
  type A2aStreamResponse,
} from "./types";

export class A2aClientError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
    readonly status?: number,
  ) {
    super(message);
    this.name = "A2aClientError";
  }
}

export type A2aFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const object = (value: unknown, field: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new A2aClientError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
};

const secureUrl = (value: unknown, field: string) => {
  if (typeof value !== "string")
    throw new A2aClientError(`${field} must be a URL`);
  const url = new URL(value);
  const local =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if ((url.protocol !== "https:" && !local) || url.username || url.password) {
    throw new A2aClientError(`${field} must use HTTPS without credentials`);
  }
  return url.toString();
};

export const parseA2aAgentCard = (value: unknown): A2aAgentCard => {
  const card = object(value, "Agent Card");
  if (
    typeof card.name !== "string" ||
    typeof card.description !== "string" ||
    typeof card.version !== "string" ||
    !Array.isArray(card.supportedInterfaces) ||
    !Array.isArray(card.skills) ||
    !Array.isArray(card.defaultInputModes) ||
    !Array.isArray(card.defaultOutputModes)
  ) {
    throw new A2aClientError("Agent Card is missing required fields");
  }
  for (const [index, candidate] of card.supportedInterfaces.entries()) {
    const agentInterface = object(candidate, `supportedInterfaces[${index}]`);
    if (
      typeof agentInterface.protocolBinding !== "string" ||
      typeof agentInterface.protocolVersion !== "string"
    ) {
      throw new A2aClientError("Agent Card has an invalid interface");
    }
    secureUrl(agentInterface.url, `supportedInterfaces[${index}].url`);
  }
  return value as A2aAgentCard;
};

export const discoverA2aAgent = async (
  origin: string,
  options?: {
    fetch?: A2aFetch;
    headers?: HeadersInit;
    maxResponseBytes?: number;
    timeoutMs?: number;
  },
): Promise<A2aAgentCard> => {
  const discoveryUrl = new URL(
    A2A_AGENT_CARD_PATH,
    secureUrl(origin, "origin"),
  );
  const response = await (options?.fetch ?? fetch)(discoveryUrl, {
    headers: { accept: "application/json", ...options?.headers },
    redirect: "error",
    signal: AbortSignal.timeout(options?.timeoutMs ?? 10_000),
  });
  if (!response.ok) {
    throw new A2aClientError(
      "Agent Card discovery failed",
      undefined,
      undefined,
      response.status,
    );
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw new A2aClientError("Agent Card response is not JSON");
  }
  const text = await response.text();
  if (
    new TextEncoder().encode(text).byteLength >
    (options?.maxResponseBytes ?? 1_048_576)
  ) {
    throw new A2aClientError("Agent Card response is too large");
  }
  try {
    return parseA2aAgentCard(JSON.parse(text));
  } catch (error) {
    if (error instanceof A2aClientError) throw error;
    throw new A2aClientError("Agent Card returned invalid JSON");
  }
};

export const createA2aClient = ({
  agentCard,
  fetch: request = fetch,
  headers,
  extensions = [],
  maxResponseBytes = 5_000_000,
  protocolVersion = A2A_PROTOCOL_VERSION,
  timeoutMs = 30_000,
}: {
  agentCard: A2aAgentCard;
  extensions?: string[];
  fetch?: A2aFetch;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  maxResponseBytes?: number;
  protocolVersion?: string;
  timeoutMs?: number;
}) => {
  const parsedAgentCard = parseA2aAgentCard(agentCard);
  const selected = parsedAgentCard.supportedInterfaces.find(
    (entry) =>
      entry.protocolBinding === "JSONRPC" &&
      entry.protocolVersion === protocolVersion,
  );
  if (!selected) {
    throw new A2aClientError(
      `Agent does not advertise A2A ${protocolVersion} JSON-RPC`,
    );
  }
  let counter = 0;
  const call = async <Result>(
    method: string,
    params: unknown,
  ): Promise<Result> => {
    const supplied = typeof headers === "function" ? await headers() : headers;
    const requestHeaders = new Headers(supplied);
    requestHeaders.set("a2a-version", protocolVersion);
    if (extensions.length > 0) {
      requestHeaders.set("a2a-extensions", extensions.join(","));
    }
    requestHeaders.set("content-type", "application/json");
    const response = await request(selected.url, {
      body: JSON.stringify({
        id: `a2a_${++counter}`,
        jsonrpc: "2.0",
        method,
        params: {
          ...(typeof params === "object" && params !== null ? params : {}),
          ...(selected.tenant === undefined ? {} : { tenant: selected.tenant }),
        },
      }),
      headers: requestHeaders,
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new A2aClientError(
        "A2A HTTP request failed",
        undefined,
        undefined,
        response.status,
      );
    }
    const contentType =
      response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/json")) {
      throw new A2aClientError(
        "A2A response is not JSON",
        undefined,
        undefined,
        response.status,
      );
    }
    const source = await response.text();
    if (new TextEncoder().encode(source).byteLength > maxResponseBytes) {
      throw new A2aClientError(
        "A2A response is too large",
        undefined,
        undefined,
        response.status,
      );
    }
    let body: {
      error?: { code: number; data?: unknown; message: string };
      result?: Result;
    };
    try {
      body = JSON.parse(source) as typeof body;
    } catch {
      throw new A2aClientError(
        "A2A response returned invalid JSON",
        undefined,
        undefined,
        response.status,
      );
    }
    if (body.error) {
      throw new A2aClientError(
        body.error.message,
        body.error.code,
        body.error.data,
        response.status,
      );
    }
    if (body.result === undefined)
      throw new A2aClientError("Invalid A2A response");
    return body.result;
  };

  const stream = async function* <Result>(
    method: string,
    params: unknown,
  ): AsyncGenerator<Result> {
    const supplied = typeof headers === "function" ? await headers() : headers;
    const requestHeaders = new Headers(supplied);
    requestHeaders.set("a2a-version", protocolVersion);
    requestHeaders.set("accept", "text/event-stream");
    requestHeaders.set("content-type", "application/json");
    if (extensions.length > 0)
      requestHeaders.set("a2a-extensions", extensions.join(","));
    const response = await request(selected.url, {
      body: JSON.stringify({
        id: `a2a_${++counter}`,
        jsonrpc: "2.0",
        method,
        params: {
          ...(typeof params === "object" && params !== null ? params : {}),
          ...(selected.tenant === undefined ? {} : { tenant: selected.tenant }),
        },
      }),
      headers: requestHeaders,
      method: "POST",
      redirect: "error",
    });
    if (!response.ok) {
      throw new A2aClientError(
        "A2A streaming request failed",
        undefined,
        undefined,
        response.status,
      );
    }
    const contentType =
      response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/event-stream")) {
      throw new A2aClientError(
        "A2A streaming response is not an event stream",
        undefined,
        undefined,
        response.status,
      );
    }
    const reader = response.body?.getReader();
    if (reader === undefined)
      throw new A2aClientError("A2A stream has no body");
    const decoder = new TextDecoder();
    let buffer = "";
    let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxResponseBytes) {
        await reader.cancel();
        throw new A2aClientError("A2A stream is too large");
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/u);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const line = frame
          .split(/\r?\n/u)
          .find((entry) => entry.startsWith("data:"));
        if (line === undefined) continue;
        let envelope: {
          error?: { code: number; data?: unknown; message: string };
          result?: Result;
        };
        try {
          envelope = JSON.parse(line.slice(5).trim()) as typeof envelope;
        } catch {
          throw new A2aClientError("A2A stream returned invalid JSON");
        }
        if (envelope.error !== undefined) {
          throw new A2aClientError(
            envelope.error.message,
            envelope.error.code,
            envelope.error.data,
          );
        }
        if (envelope.result !== undefined) yield envelope.result;
      }
    }
  };

  return {
    agentCard: parsedAgentCard,
    cancelTask: async (params: A2aCancelTaskRequest) =>
      await call<A2aTask>("CancelTask", params),
    getTask: async (params: A2aGetTaskRequest) =>
      await call<A2aTask>("GetTask", params),
    createPushNotificationConfig: (config: A2aPushNotificationConfig) =>
      call<A2aPushNotificationConfig>(
        "CreateTaskPushNotificationConfig",
        config,
      ),
    deletePushNotificationConfig: (taskId: string, id: string) =>
      call<Record<string, never>>("DeleteTaskPushNotificationConfig", {
        id,
        taskId,
      }),
    getExtendedAgentCard: async () =>
      parseA2aAgentCard(await call<A2aAgentCard>("GetExtendedAgentCard", {})),
    getPushNotificationConfig: (taskId: string, id: string) =>
      call<A2aPushNotificationConfig>("GetTaskPushNotificationConfig", {
        id,
        taskId,
      }),
    listPushNotificationConfigs: (taskId: string) =>
      call<{ configs: A2aPushNotificationConfig[]; nextPageToken?: string }>(
        "ListTaskPushNotificationConfigs",
        { taskId },
      ),
    listTasks: (params: A2aListTasksRequest = {}) =>
      call<A2aListTasksResponse>("ListTasks", params),
    sendMessage: (params: A2aSendMessageRequest) =>
      call<A2aSendMessageResponse>("SendMessage", params),
    sendStreamingMessage: (params: A2aSendMessageRequest) =>
      stream<A2aStreamResponse>("SendStreamingMessage", params),
    subscribeToTask: (id: string) =>
      stream<A2aStreamResponse>("SubscribeToTask", { id }),
  };
};
