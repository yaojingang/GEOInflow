import { saveAuth } from '@/lib/auth';
import { AUTH_SESSION_TTL, PARTIAL_AUTH_TOKEN_TYPE, ROLES } from '@/lib/constants';
import { hash, secret } from '@/lib/crypto';
import { createSecureToken } from '@/lib/jwt';
import { checkPassword } from '@/lib/password';
import prisma from '@/lib/prisma';
import redis from '@/lib/redis';
import { parseRequest } from '@/lib/request';
import { json, serviceUnavailable, unauthorized } from '@/lib/response';
import { getTwoFactorConfigurationError, isTwoFactorConfigured } from '@/lib/two-factor/crypto';
import { getAllUserTeams, getUserByUsername } from '@/queries/prisma';
import { loginRequestSchema } from './schema';
import { acquireLoginAttempt } from '@/lib/liekan/upstream/login-attempts';
import { ShareAttemptError } from '@/lib/liekan/upstream/share-attempts';

export async function POST(request: Request) {
  const { body, error } = await parseRequest(request, loginRequestSchema, { skipAuth: true });

  if (error) {
    return error();
  }

  const { username, password } = body;

  let release: () => void;
  try {
    release = await acquireLoginAttempt(request, username);
  } catch (error) {
    if (!(error instanceof ShareAttemptError)) throw error;
    return Response.json(
      {
        error: {
          code: error.status === 429 ? 'login-throttled' : 'login-unavailable',
          message:
            error.status === 429
              ? 'Too many login attempts. Try again later.'
              : 'Login temporarily unavailable.',
          status: error.status,
        },
      },
      {
        status: error.status,
        headers: {
          'Retry-After': String(error.retryAfter),
          'Cache-Control': 'private, no-store',
        },
      },
    );
  }

  try {
    const user = await getUserByUsername(username, { includePassword: true });

    if (!user || !checkPassword(password, user.password)) {
      return unauthorized({ code: 'incorrect-username-password' });
    }

    const { id, role, createdAt } = user;
    const cloudMode = !!process.env.CLOUD_MODE;

    // Check if 2FA is enabled for this user
    const twoFactor = !cloudMode
      ? await prisma.client.twoFactorAuth.findUnique({ where: { userId: id } })
      : null;

    if (twoFactor?.isEnabled) {
      if (!isTwoFactorConfigured()) {
        return serviceUnavailable(getTwoFactorConfigurationError());
      }

      const partialToken = createSecureToken(
        { userId: id, type: PARTIAL_AUTH_TOKEN_TYPE },
        secret(),
        {
          expiresIn: '5m',
        },
      );
      return json({ requiresTwoFactor: true, partialToken });
    }
    // Bind token to password hash so a password change invalidates old tokens.
    const pwd = hash(user.password);

    let token: string;

    if (redis.enabled) {
      token = await saveAuth({ userId: id, role, pwd }, AUTH_SESSION_TTL);
    } else {
      token = createSecureToken({ userId: user.id, role, pwd }, secret(), {
        expiresIn: AUTH_SESSION_TTL,
      });
    }

    const teams = await getAllUserTeams(id);

    return json({
      token,
      user: { id, username, role, createdAt, isAdmin: role === ROLES.admin, teams },
    });
  } finally {
    release();
  }
}
