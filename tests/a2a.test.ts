import { describe, expect, test } from "bun:test";
import {
  allowAllPolicy,
  createAgency,
  createMemoryAgencyStore,
} from "@absolutejs/agency";
import {
  A2A_PROTOCOL_VERSION,
  ABSOLUTE_AGENCY_EXTENSION,
  A2aClientError,
  createA2aClient,
  createA2aHandler,
  createMemoryA2aTaskStore,
  discoverA2aAgent,
  type A2aAgentCard,
  type A2aTask,
} from "../src";

const card: A2aAgentCard = {
  capabilities: {},
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  description: "Test agent",
  name: "Test",
  skills: [],
  supportedInterfaces: [
    {
      protocolBinding: "JSONRPC",
      protocolVersion: A2A_PROTOCOL_VERSION,
      url: "https://agent.test/a2a",
    },
  ],
  version: "1.0.0",
};

const task = (id: string): A2aTask => ({
  contextId: "context-1",
  id,
  status: { state: "TASK_STATE_WORKING" },
});

const makeHandler = () =>
  createA2aHandler({
    agency: {
      agency: createAgency({
        policy: allowAllPolicy(),
        store: createMemoryAgencyStore(),
      }),
    },
    agentCard: card,
    authorize: (request) =>
      request.headers.get("authorization") === "Bearer good"
        ? {
            actor: {
              agentId: "caller-agent",
              scopes: ["a2a"],
              userId: "user-1",
            },
            authorizationKey: "user-1",
            caller: { id: "user-1" },
            ok: true as const,
          }
        : { ok: false as const },
    sendMessage: async ({ message }) => ({
      task: task(`task-${message.messageId}`),
    }),
    taskStore: createMemoryA2aTaskStore(),
  });

describe("A2A 1.0 server and client", () => {
  test("discovers the card and round-trips required task operations", async () => {
    const handler = makeHandler();
    const localFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const response = await handler(request);
      return response ?? new Response("not found", { status: 404 });
    };
    const discovered = await discoverA2aAgent("https://agent.test", {
      fetch: localFetch,
    });
    expect(discovered.capabilities.extensions?.[0]?.uri).toContain("agency");
    const client = createA2aClient({
      agentCard: discovered,
      fetch: localFetch,
      headers: { authorization: "Bearer good" },
    });
    const sent = await client.sendMessage({
      message: {
        messageId: "m1",
        parts: [{ text: "hello" }],
        role: "ROLE_USER",
      },
    });
    expect(sent.task?.id).toBe("task-m1");
    expect((await client.getTask({ id: "task-m1" })).id).toBe("task-m1");
    expect((await client.cancelTask({ id: "task-m1" })).status.state).toBe(
      "TASK_STATE_CANCELED",
    );
  });

  test("rejects missing protocol version and unauthenticated calls", async () => {
    const handler = makeHandler();
    const missingVersion = await handler(
      new Request("https://agent.test/a2a", {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "ListTasks",
          params: {},
        }),
        headers: {
          authorization: "Bearer good",
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );
    expect(await missingVersion?.json()).toMatchObject({
      error: { code: -32009 },
    });
    const unauthorized = await handler(
      new Request("https://agent.test/a2a", { method: "POST" }),
    );
    expect(unauthorized?.status).toBe(401);
  });

  test("returns an approvable action and resumes that exact action", async () => {
    const agency = createAgency({
      policy: {
        evaluate: ({ approval, now }) =>
          approval
            ? {
                decisionId: crypto.randomUUID(),
                evaluatedAt: now,
                kind: "allow" as const,
              }
            : {
                decisionId: crypto.randomUUID(),
                evaluatedAt: now,
                kind: "deny" as const,
                reason: "human approval required",
                requestable: true,
              },
      },
      store: createMemoryAgencyStore(),
    });
    const handler = createA2aHandler({
      agency: { agency },
      agentCard: card,
      authorize: () => ({
        actor: { agentId: "agent", scopes: ["a2a"], userId: "user" },
        authorizationKey: "user",
        caller: {},
        ok: true,
      }),
      sendMessage: ({ message }) => ({
        task: task(`task-${message.messageId}`),
      }),
      taskStore: createMemoryA2aTaskStore(),
    });
    const localFetch = async (input: RequestInfo | URL, init?: RequestInit) =>
      (await handler(new Request(input, init))) ??
      new Response(null, { status: 404 });
    const client = createA2aClient({ agentCard: card, fetch: localFetch });
    let actionId = "";
    try {
      await client.sendMessage({
        message: {
          messageId: "approval",
          parts: [{ text: "do it" }],
          role: "ROLE_USER",
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(A2aClientError);
      const details = (error as A2aClientError).data as Array<{
        actionId: string;
      }>;
      actionId = details[0]?.actionId ?? "";
    }
    expect(actionId).not.toBe("");
    await agency.approve({
      actionId,
      approvedBy: "user",
      approvedUntil: Date.now() + 60_000,
    });
    const resumed = await client.sendMessage({
      message: {
        messageId: "approval",
        parts: [{ text: "do it" }],
        role: "ROLE_USER",
      },
      metadata: {
        [ABSOLUTE_AGENCY_EXTENSION]: { actionId },
      },
    });
    expect(resumed.task?.id).toBe("task-approval");
    expect((await agency.inspect()).receipts).toHaveLength(1);
  });
});
