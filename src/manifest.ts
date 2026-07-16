import { defineManifest } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";

export const manifest = defineManifest<Record<string, never>>()({
  contract: 2,
  identity: {
    accent: "#8b5cf6",
    category: "ai",
    description:
      "A2A Protocol 1.0 JSON-RPC client and server with Agent Card discovery, version negotiation, caller-bound durable tasks, and approval-resumable AbsoluteJS Agency enforcement.",
    docsUrl: "https://github.com/absolutejs/a2a",
    name: "@absolutejs/a2a",
    tagline:
      "Let authorized agents collaborate over the accepted A2A standard.",
  },
  settings: Type.Object({}),
  wiring: [],
});
