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
  createMemoryA2aPushNotificationConfigStore,
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

  test("persists authentication-controlled labels for bounded operator views", async () => {
    const taskStore = createMemoryA2aTaskStore();
    const handler = createA2aHandler({
      agentCard: card,
      authorize: () => ({
        actor: { agentId: "agent-1", scopes: ["a2a"], userId: "user-1" },
        authorizationKey: "private-owner-key",
        caller: {},
        ok: true,
        taskLabels: {
          clientId: "agent-1",
          transport: "a2a",
          userId: "user-1",
        },
      }),
      sendMessage: ({ message }) => ({
        task: {
          artifacts: [
            { artifactId: "secret", parts: [{ text: "private output" }] },
          ],
          contextId: "context-1",
          history: [message],
          id: "operator-task",
          status: { state: "TASK_STATE_COMPLETED" },
        },
      }),
      taskStore,
    });
    await handler(
      new Request("https://agent.test/a2a", {
        body: JSON.stringify({
          id: 1,
          jsonrpc: "2.0",
          method: "SendMessage",
          params: {
            message: {
              messageId: "operator",
              parts: [{ text: "hello" }],
              role: "ROLE_USER",
            },
          },
        }),
        headers: {
          "a2a-version": "1.0",
          "content-type": "application/json",
        },
        method: "POST",
      }),
    );
    const visible = await taskStore.listForOperator({
      labels: { transport: "a2a", userId: "user-1" },
    });
    expect(visible.totalSize).toBe(1);
    expect(visible.items[0]?.labels.clientId).toBe("agent-1");
    expect(visible.items[0]?.task.artifacts).toBeUndefined();
    expect(visible.items[0]?.task.history).toEqual([]);
    expect(
      await taskStore.listForOperator({ labels: { userId: "user-2" } }),
    ).toMatchObject({ totalSize: 0 });
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

  test("supports streaming, subscriptions, task filters, push configs, and extended cards", async () => {
    const productionCard: A2aAgentCard = {
      ...card,
      capabilities: {
        extendedAgentCard: true,
        pushNotifications: true,
        streaming: true,
      },
    };
    const extendedCard: A2aAgentCard = {
      ...productionCard,
      name: "Test (authenticated)",
      skills: [
        {
          description: "A private authenticated capability",
          id: "private",
          name: "Private skill",
          tags: ["private"],
        },
      ],
    };
    const handler = createA2aHandler({
      agentCard: productionCard,
      authorize: () => ({
        actor: { agentId: "agent", scopes: ["a2a"], userId: "user" },
        authorizationKey: "user",
        caller: {},
        ok: true,
      }),
      extendedAgentCard: extendedCard,
      pushNotifications: {
        store: createMemoryA2aPushNotificationConfigStore(),
      },
      sendMessage: ({ message }) => ({
        task: task(`task-${message.messageId}`),
      }),
      sendStreamingMessage: async function* ({ message }) {
        yield { task: task(`stream-${message.messageId}`) };
        yield {
          statusUpdate: {
            final: false,
            status: { state: "TASK_STATE_WORKING" },
            taskId: `stream-${message.messageId}`,
          },
        };
      },
      subscribeToTask: async function* (subscribed) {
        yield {
          statusUpdate: {
            final: true,
            status: { state: "TASK_STATE_COMPLETED" },
            taskId: subscribed.id,
          },
        };
      },
      taskStore: createMemoryA2aTaskStore(),
    });
    const localFetch = async (input: RequestInfo | URL, init?: RequestInit) =>
      (await handler(new Request(input, init))) ??
      new Response(null, { status: 404 });
    const client = createA2aClient({
      agentCard: productionCard,
      fetch: localFetch,
    });

    await client.sendMessage({
      message: {
        messageId: "features",
        parts: [{ text: "test all features" }],
        role: "ROLE_USER",
      },
    });
    const listed = await client.listTasks({
      contextId: "context-1",
      includeArtifacts: false,
      pageSize: 1,
      status: "TASK_STATE_WORKING",
    });
    expect(listed.tasks.map((entry) => entry.id)).toEqual(["task-features"]);
    expect(listed).toMatchObject({ pageSize: 1, totalSize: 1 });

    const streamed = [];
    for await (const event of client.sendStreamingMessage({
      message: {
        messageId: "features",
        parts: [{ text: "stream" }],
        role: "ROLE_USER",
      },
    })) {
      streamed.push(event);
    }
    expect(streamed).toHaveLength(2);

    const subscribed = [];
    for await (const event of client.subscribeToTask("task-features")) {
      subscribed.push(event);
    }
    expect(subscribed).toHaveLength(2);
    expect(subscribed[0]).toMatchObject({ task: { id: "task-features" } });

    const created = await client.createPushNotificationConfig({
      taskId: "task-features",
      token: "verification-secret",
      url: "https://hooks.example/a2a",
    });
    expect(created.id).toBeString();
    expect(
      await client.getPushNotificationConfig(
        "task-features",
        created.id as string,
      ),
    ).toEqual(created);
    expect(
      (await client.listPushNotificationConfigs("task-features")).configs,
    ).toEqual([created]);
    await client.deletePushNotificationConfig(
      "task-features",
      created.id as string,
    );
    expect(
      (await client.listPushNotificationConfigs("task-features")).configs,
    ).toEqual([]);
    expect((await client.getExtendedAgentCard()).name).toBe(
      "Test (authenticated)",
    );

    await expect(
      client.createPushNotificationConfig({
        taskId: "task-features",
        url: "http://public.example/hook",
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  test("enforces content, size, and required extension boundaries", async () => {
    const requiredCard: A2aAgentCard = {
      ...card,
      capabilities: {
        extensions: [
          {
            required: true,
            uri: "https://extensions.example/required/v1",
          },
        ],
      },
    };
    const handler = createA2aHandler({
      agentCard: requiredCard,
      authorize: () => ({
        actor: { agentId: "agent", scopes: ["a2a"], userId: "user" },
        authorizationKey: "user",
        caller: {},
        ok: true,
      }),
      maxRequestBytes: 64,
      sendMessage: ({ message }) => ({ task: task(message.messageId) }),
      taskStore: createMemoryA2aTaskStore(),
    });
    const base = {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "ListTasks" }),
      headers: { "a2a-version": "1.0" },
      method: "POST",
    };
    expect(
      await (
        await handler(new Request("https://agent.test/a2a", base))
      )?.json(),
    ).toMatchObject({ error: { code: -32005 } });
    expect(
      await (
        await handler(
          new Request("https://agent.test/a2a", {
            ...base,
            body: JSON.stringify({ padding: "x".repeat(100) }),
            headers: {
              ...base.headers,
              "content-type": "application/json",
            },
          }),
        )
      )?.json(),
    ).toMatchObject({ error: { code: -32600 } });
    expect(
      await (
        await handler(
          new Request("https://agent.test/a2a", {
            ...base,
            headers: {
              ...base.headers,
              "content-type": "application/json",
            },
          }),
        )
      )?.json(),
    ).toMatchObject({ error: { code: -32008 } });
  });

  test("rejects insecure origins and malformed discovery documents", async () => {
    await expect(discoverA2aAgent("http://agent.example")).rejects.toThrow(
      "HTTPS",
    );
    await expect(
      discoverA2aAgent("https://agent.example", {
        fetch: async () =>
          new Response(JSON.stringify({ name: "incomplete" }), {
            headers: { "content-type": "application/json" },
          }),
      }),
    ).rejects.toThrow("missing required fields");
    await expect(
      discoverA2aAgent("https://agent.example", {
        fetch: async () =>
          new Response("x".repeat(100), {
            headers: { "content-type": "application/json" },
          }),
        maxResponseBytes: 10,
      }),
    ).rejects.toThrow("too large");
  });

  test("refuses capability claims without corresponding server configuration", () => {
    expect(() =>
      createA2aHandler({
        agentCard: { ...card, capabilities: { pushNotifications: true } },
        authorize: () => ({ ok: false }),
        sendMessage: ({ message }) => ({ task: task(message.messageId) }),
        taskStore: createMemoryA2aTaskStore(),
      }),
    ).toThrow("no push store");
  });
});
