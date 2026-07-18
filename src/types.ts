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

export type A2aStreamResponse =
  | { artifactUpdate: Record<string, unknown> }
  | { message: A2aMessage }
  | { statusUpdate: Record<string, unknown> }
  | { task: A2aTask };

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

export type A2aListTasksRequest = {
  contextId?: string;
  historyLength?: number;
  includeArtifacts?: boolean;
  pageSize?: number;
  pageToken?: string;
  status?: A2aTaskState;
  statusTimestampAfter?: string;
  tenant?: string;
};

export type A2aListTasksResponse = {
  nextPageToken: string;
  pageSize: number;
  tasks: A2aTask[];
  totalSize: number;
};

export type A2aTaskLabels = Record<string, string>;

export type A2aOperatorListTasksRequest = A2aListTasksRequest & {
  labels?: A2aTaskLabels;
};

export type A2aOperatorTask = {
  labels: A2aTaskLabels;
  task: A2aTask;
};

export type A2aOperatorListTasksResponse = {
  items: A2aOperatorTask[];
  nextPageToken: string;
  pageSize: number;
  totalSize: number;
};

export type A2aPushNotificationConfig = {
  authentication?: { credentials?: string; scheme: string };
  id?: string;
  taskId?: string;
  token?: string;
  url: string;
};

export type A2aPushNotificationConfigStore = {
  create: (
    config: A2aPushNotificationConfig,
    authorizationKey: string,
  ) => Promise<A2aPushNotificationConfig> | A2aPushNotificationConfig;
  delete: (
    taskId: string,
    id: string,
    authorizationKey: string,
  ) => Promise<boolean> | boolean;
  get: (
    taskId: string,
    id: string,
    authorizationKey: string,
  ) =>
    | Promise<A2aPushNotificationConfig | undefined>
    | A2aPushNotificationConfig
    | undefined;
  list: (
    taskId: string,
    authorizationKey: string,
  ) => Promise<A2aPushNotificationConfig[]> | A2aPushNotificationConfig[];
};

export type A2aTaskStore = {
  cancel: (
    id: string,
    authorizationKey: string,
    now: string,
  ) => Promise<A2aTask | undefined>;
  get: (id: string, authorizationKey: string) => Promise<A2aTask | undefined>;
  list: (
    authorizationKey: string,
    request: A2aListTasksRequest,
  ) => Promise<A2aListTasksResponse>;
  save: (
    task: A2aTask,
    authorizationKey: string,
    labels?: A2aTaskLabels,
  ) => Promise<void>;
};

export type A2aTaskOperatorStore = {
  listForOperator: (
    request: A2aOperatorListTasksRequest,
  ) => Promise<A2aOperatorListTasksResponse>;
};

export type A2aAuthResult<Caller> =
  | { ok: false; reason?: string; status?: 401 | 403 }
  | {
      actor: AgentActor;
      authorizationKey: string;
      caller: Caller;
      ok: true;
      taskLabels?: A2aTaskLabels;
    };

export type A2aRequestContext<Caller> = {
  actor: AgentActor;
  authorizationKey: string;
  caller: Caller;
  request: Request;
  taskLabels?: A2aTaskLabels;
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
  /** Authenticated card with additional private skills or capabilities. */
  extendedAgentCard?:
    | A2aAgentCard
    | ((
        context: A2aRequestContext<Caller>,
      ) => Promise<A2aAgentCard> | A2aAgentCard);
  /** Maximum JSON-RPC request body size in bytes (default 1 MiB). */
  maxRequestBytes?: number;
  path?: string;
  pushNotifications?: { store: A2aPushNotificationConfigStore };
  sendMessage: (
    params: A2aSendMessageRequest,
    context: A2aRequestContext<Caller>,
  ) => Promise<A2aSendMessageResponse> | A2aSendMessageResponse;
  sendStreamingMessage?: (
    params: A2aSendMessageRequest,
    context: A2aRequestContext<Caller>,
  ) => AsyncIterable<A2aStreamResponse>;
  subscribeToTask?: (
    task: A2aTask,
    context: A2aRequestContext<Caller>,
  ) => AsyncIterable<A2aStreamResponse>;
  taskStore: A2aTaskStore;
};
