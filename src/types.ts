import type {
  ActionRequestInput,
  Agency,
  AgentActor,
} from "@absolutejs/agency";

export const A2A_PROTOCOL_VERSION = "1.0" as const;
export const A2A_AGENT_CARD_PATH = "/.well-known/agent-card.json" as const;
export const ABSOLUTE_AGENCY_EXTENSION =
  "https://github.com/absolutejs/agency/extensions/a2a/v1" as const;

export type A2aSecurityRequirement = {
  schemes: Record<string, { list: string[] }>;
};

export type A2aPart =
  | { text: string; metadata?: Record<string, unknown> }
  | { data: unknown; mediaType?: string; metadata?: Record<string, unknown> }
  | {
      url: string;
      filename?: string;
      mediaType?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      raw: string;
      filename?: string;
      mediaType?: string;
      metadata?: Record<string, unknown>;
    };

export type A2aMessage = {
  contextId?: string;
  extensions?: string[];
  messageId: string;
  metadata?: Record<string, unknown>;
  parts: A2aPart[];
  role: "ROLE_USER" | "ROLE_AGENT";
  taskId?: string;
};

export type A2aTaskState =
  | "TASK_STATE_SUBMITTED"
  | "TASK_STATE_WORKING"
  | "TASK_STATE_INPUT_REQUIRED"
  | "TASK_STATE_AUTH_REQUIRED"
  | "TASK_STATE_COMPLETED"
  | "TASK_STATE_CANCELED"
  | "TASK_STATE_FAILED"
  | "TASK_STATE_REJECTED";

export type A2aArtifact = {
  artifactId: string;
  description?: string;
  extensions?: string[];
  metadata?: Record<string, unknown>;
  name?: string;
  parts: A2aPart[];
};

export type A2aTask = {
  artifacts?: A2aArtifact[];
  contextId: string;
  history?: A2aMessage[];
  id: string;
  metadata?: Record<string, unknown>;
  status: { message?: A2aMessage; state: A2aTaskState; timestamp?: string };
};

export type A2aAgentInterface = {
  protocolBinding: "JSONRPC" | "GRPC" | "HTTP+JSON" | (string & {});
  protocolVersion: string;
  tenant?: string;
  url: string;
};

export type A2aAgentSkill = {
  description: string;
  examples?: string[];
  id: string;
  inputModes?: string[];
  name: string;
  outputModes?: string[];
  securityRequirements?: A2aSecurityRequirement[];
  tags: string[];
};

export type A2aAgentCard = {
  capabilities: {
    extendedAgentCard?: boolean;
    extensions?: Array<{
      description?: string;
      params?: unknown;
      required?: boolean;
      uri: string;
    }>;
    pushNotifications?: boolean;
    streaming?: boolean;
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  description: string;
  documentationUrl?: string;
  iconUrl?: string;
  name: string;
  provider?: { organization: string; url: string };
  securityRequirements?: A2aSecurityRequirement[];
  securitySchemes?: Record<string, unknown>;
  signatures?: Array<{
    header?: Record<string, unknown>;
    protected: string;
    signature: string;
  }>;
  skills: A2aAgentSkill[];
  supportedInterfaces: A2aAgentInterface[];
  version: string;
};

export type A2aSendMessageRequest = {
  configuration?: {
    acceptedOutputModes?: string[];
    historyLength?: number;
    returnImmediately?: boolean;
  };
  message: A2aMessage;
  metadata?: Record<string, unknown>;
  tenant?: string;
};
export type A2aSendMessageResponse =
  | { message: A2aMessage; task?: never }
  | { task: A2aTask; message?: never };
export type A2aGetTaskRequest = {
  historyLength?: number;
  id: string;
  tenant?: string;
};
export type A2aCancelTaskRequest = {
  id: string;
  metadata?: Record<string, unknown>;
  tenant?: string;
};

export type A2aTaskStore = {
  cancel: (
    id: string,
    authorizationKey: string,
    now: string,
  ) => Promise<A2aTask | undefined>;
  get: (id: string, authorizationKey: string) => Promise<A2aTask | undefined>;
  list: (authorizationKey: string) => Promise<A2aTask[]>;
  save: (task: A2aTask, authorizationKey: string) => Promise<void>;
};

export type A2aAuthResult<Caller> =
  | { ok: false; reason?: string; status?: 401 | 403 }
  | { actor: AgentActor; authorizationKey: string; caller: Caller; ok: true };

export type A2aRequestContext<Caller> = {
  actor: AgentActor;
  authorizationKey: string;
  caller: Caller;
  request: Request;
};

export type A2aAgencyOptions<Caller> = {
  agency: Agency;
  actionFor?: (
    operation: "SendMessage" | "CancelTask",
    params: unknown,
    context: A2aRequestContext<Caller>,
  ) => ActionRequestInput;
};

export type A2aServerConfig<Caller> = {
  agency?: A2aAgencyOptions<Caller>;
  agentCard: A2aAgentCard;
  authorize: (
    request: Request,
  ) => Promise<A2aAuthResult<Caller>> | A2aAuthResult<Caller>;
  cancelTask?: (
    params: A2aCancelTaskRequest,
    context: A2aRequestContext<Caller>,
  ) => Promise<A2aTask> | A2aTask;
  path?: string;
  sendMessage: (
    params: A2aSendMessageRequest,
    context: A2aRequestContext<Caller>,
  ) => Promise<A2aSendMessageResponse> | A2aSendMessageResponse;
  taskStore: A2aTaskStore;
};
