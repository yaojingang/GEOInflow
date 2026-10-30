import { createClient } from 'redis';
import { configuredIp } from '@/lib/ip';
import redis from '@/lib/redis';
import { processSingleton } from './process-singleton';
import {
  type AttemptBackend,
  createShareAttemptGuard,
  SHARE_PASSWORD_LIMITS,
} from './share-attempts';

export const LOGIN_LIMITS = {
  ...SHARE_PASSWORD_LIMITS,
  windowMs: 60000,
  share: 10,
  client: 30,
} as const;

function loginBackend(): AttemptBackend {
  if (redis.enabled || !process.env.LIEKAN_ANALYTICS_REDIS_URL) return redis;
  // Use the bundled shared Redis without moving authentication sessions into its evictable cache.
  const client = createClient({
    url: process.env.LIEKAN_ANALYTICS_REDIS_URL,
    disableOfflineQueue: true,
    commandsQueueMaxLength: 8,
    socket: { connectTimeout: 1000, reconnectStrategy: false },
  });
  client.on('error', () => {});
  let connecting: Promise<unknown> | undefined;
  return {
    enabled: true,
    client: {
      client,
      async connect() {
        if (client.isReady) return;
        connecting ??= client.connect().finally(() => {
          connecting = undefined;
        });
        await connecting;
      },
    },
  };
}

export function createLoginAttemptGuard(
  options: Parameters<typeof createShareAttemptGuard>[0] = {},
) {
  const guard = createShareAttemptGuard({
    limits: LOGIN_LIMITS,
    namespace: 'login-password',
    // Unconfigured forwarding headers never create independent rate-limit identities.
    clientAddress: headers => configuredIp(headers)?.ip,
    clientPerResource: false,
    ...options,
  });
  return (request: Request, username: string) =>
    guard(request, username.normalize('NFKC').trim().toLowerCase());
}

export async function acquireLoginAttempt(request: Request, username: string) {
  const guard = processSingleton('login-password-attempts-v1', () =>
    createLoginAttemptGuard({ backend: loginBackend() }),
  );
  return guard(request, username);
}
