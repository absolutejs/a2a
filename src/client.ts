import {
  A2A_AGENT_CARD_PATH,
  A2A_PROTOCOL_VERSION,
  type A2aAgentCard,
  type A2aCancelTaskRequest,
  type A2aGetTaskRequest,
  type A2aSendMessageRequest,
  type A2aSendMessageResponse,
  type A2aTask,
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

export const discoverA2aAgent = async (
  origin: string,
  options?: { fetch?: A2aFetch; headers?: HeadersInit },
): Promise<A2aAgentCard> => {
  const response = await (options?.fetch ?? fetch)(
    new URL(A2A_AGENT_CARD_PATH, origin),
    { headers: options?.headers },
  );
  if (!response.ok) {
    throw new A2aClientError(
      "Agent Card discovery failed",
      undefined,
      undefined,
      response.status,
    );
  }
  return (await response.json()) as A2aAgentCard;
};

export const createA2aClient = ({
  agentCard,
  fetch: request = fetch,
  headers,
}: {
  agentCard: A2aAgentCard;
  fetch?: A2aFetch;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
}) => {
  const selected = agentCard.supportedInterfaces.find(
    (entry) =>
      entry.protocolBinding === "JSONRPC" &&
      entry.protocolVersion === A2A_PROTOCOL_VERSION,
  );
  if (!selected) {
    throw new A2aClientError("Agent does not advertise A2A 1.0 JSON-RPC");
  }
  let counter = 0;
  const call = async <Result>(
    method: string,
    params: unknown,
  ): Promise<Result> => {
    const supplied = typeof headers === "function" ? await headers() : headers;
    const requestHeaders = new Headers(supplied);
    requestHeaders.set("a2a-version", A2A_PROTOCOL_VERSION);
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
    });
    if (!response.ok) {
      throw new A2aClientError(
        "A2A HTTP request failed",
        undefined,
        undefined,
        response.status,
      );
    }
    const body = (await response.json()) as {
      error?: { code: number; data?: unknown; message: string };
      result?: Result;
    };
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

  return {
    agentCard,
    cancelTask: async (params: A2aCancelTaskRequest) =>
      (await call<{ task: A2aTask }>("CancelTask", params)).task,
    getTask: async (params: A2aGetTaskRequest) =>
      (await call<{ task: A2aTask }>("GetTask", params)).task,
    listTasks: async () =>
      (await call<{ tasks: A2aTask[] }>("ListTasks", {})).tasks,
    sendMessage: (params: A2aSendMessageRequest) =>
      call<A2aSendMessageResponse>("SendMessage", params),
  };
};
