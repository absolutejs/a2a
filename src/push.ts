import type {
  A2aPushNotificationConfig,
  A2aPushNotificationConfigStore,
} from "./types";

type Stored = {
  authorizationKey: string;
  config: A2aPushNotificationConfig & { id: string; taskId: string };
};

export const createMemoryA2aPushNotificationConfigStore =
  (): A2aPushNotificationConfigStore => {
    const rows = new Map<string, Stored>();
    const key = (taskId: string, id: string) => `${taskId}\u0000${id}`;
    return {
      create: (config, authorizationKey) => {
        const id = config.id ?? crypto.randomUUID();
        if (config.taskId === undefined) {
          throw new Error("Push notification config requires taskId");
        }
        const complete = {
          ...structuredClone(config),
          id,
          taskId: config.taskId,
        };
        rows.set(key(config.taskId, id), {
          authorizationKey,
          config: complete,
        });
        return structuredClone(complete);
      },
      delete: (taskId, id, authorizationKey) => {
        const stored = rows.get(key(taskId, id));
        return stored?.authorizationKey === authorizationKey
          ? rows.delete(key(taskId, id))
          : false;
      },
      get: (taskId, id, authorizationKey) => {
        const stored = rows.get(key(taskId, id));
        return stored?.authorizationKey === authorizationKey
          ? structuredClone(stored.config)
          : undefined;
      },
      list: (taskId, authorizationKey) =>
        [...rows.values()]
          .filter(
            (stored) =>
              stored.authorizationKey === authorizationKey &&
              stored.config.taskId === taskId,
          )
          .map((stored) => structuredClone(stored.config)),
    };
  };

/** Validate a webhook destination without making a network request. Production
 * delivery code should additionally resolve DNS and block private/link-local
 * addresses after every redirect to prevent SSRF and rebinding. */
export const validateA2aPushUrl = (value: string) => {
  const url = new URL(value);
  const localDevelopment =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (
    (url.protocol !== "https:" && !localDevelopment) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("A2A push URL must use HTTPS without embedded credentials");
  }
  return url.toString();
};
