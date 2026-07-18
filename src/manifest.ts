import { defineManifest } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";

export const manifest = defineManifest<Record<string, never>>()({
  contract: 2,
  discovery: {
    audiences: ["agent-hosts", "agent-clients"],
    intents: [
      "serve an A2A agent",
      "call an A2A agent",
      "manage durable agent tasks",
    ],
    keywords: [
      "agents",
      "a2a",
      "agent-card",
      "tasks",
      "streaming",
      "push-notifications",
    ],
    protocols: ["A2A 1.0"],
  },
  identity: {
    accent: "#8b5cf6",
    category: "ai",
    description:
      "Production A2A Protocol 1.0 client and server with hardened discovery, streaming, subscriptions, caller-bound durable tasks and push configuration, plus approval-resumable Agency enforcement.",
    docsUrl: "https://github.com/absolutejs/a2a",
    name: "@absolutejs/a2a",
    tagline:
      "Let authorized agents collaborate over the accepted A2A standard.",
  },
  settings: Type.Object({}),
  wiring: [],
});
