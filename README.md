# @absolutejs/a2a

An A2A Protocol **1.0** JSON-RPC client and server for AbsoluteJS. It implements
Agent Card discovery, messages, streaming, task subscriptions, filtered and
paginated task listing, push notification configuration, authenticated extended
cards, explicit version and extension negotiation, and AbsoluteJS Agency
enforcement.

Protocol reference: <https://a2a-protocol.org/latest/specification/>

The protocol version is intentionally pinned. A2A 1.0 changed its JSON-RPC
method names and Agent Card shape from 0.3; this package does not silently
downgrade and lose security or behavior.

Discovery and RPC clients require HTTPS outside localhost, reject credentials
in URLs and redirects, enforce timeouts and response-size limits, and validate
response media types. Servers authenticate before parsing bodies, cap request
sizes, bind every task and push configuration to the authenticated caller, and
refuse to advertise optional capabilities that are not configured.

```ts
import { createA2aHandler, createPostgresA2aTaskStore } from "@absolutejs/a2a";

const a2a = createA2aHandler({
  path: "/a2a",
  agentCard: {
    name: "Support Agent",
    description: "Resolves customer support cases.",
    version: "1.0.0",
    supportedInterfaces: [
      {
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
        url: "https://example.com/a2a",
      },
    ],
    capabilities: {},
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [],
  },
  authorize: verifyA2aBearer,
  taskStore: createPostgresA2aTaskStore({ client }),
  agency: { agency },
  sendMessage: async ({ message }) => ({
    task: await startSupportTask(message),
  }),
});
```

The same handler supports the A2A 1.0 optional methods when their advertised
capabilities are configured:

```ts
import { createMemoryA2aPushNotificationConfigStore } from "@absolutejs/a2a";

const a2a = createA2aHandler({
  // ...the required configuration above
  pushNotifications: {
    store: createMemoryA2aPushNotificationConfigStore(),
  },
  extendedAgentCard: authenticatedCard,
  sendStreamingMessage: async function* (request, context) {
    yield* runAgentStream(request, context);
  },
  subscribeToTask: async function* (task, context) {
    yield* subscribeToAgentTask(task, context);
  },
});
```

For production push configuration storage, implement
`A2aPushNotificationConfigStore` with the same authorization-key isolation as
the included memory store. Webhook delivery should independently resolve DNS,
block private and link-local destinations, avoid redirects, authenticate each
request, and retry idempotently.

When policy requires approval, the server returns an A2A extension error with
the Agency `actionId`. After approval, resend the same request with that ID at
`metadata[ABSOLUTE_AGENCY_EXTENSION].actionId`; Agency re-evaluates policy,
issues a single-use lease, and records the execution receipt.

Task ownership is always keyed by the authorization result. A caller cannot
probe, list, cancel, or overwrite another caller's task, and PostgreSQL updates
protect terminal task states atomically.
