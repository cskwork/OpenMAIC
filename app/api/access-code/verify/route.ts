import { cookies } from 'next/headers';
import { apiError, apiSuccess } from '@/lib/server/api-response';

export async function POST(request: Request) {
  const accessCode = process.env.ACCESS_CODE;
  if (!accessCode) {
    return apiSuccess({ valid: true });
  }

  let body: { code?: string };
  try {
    body = await request.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Invalid JSON body');
  }

  if (!body.code || body.code !== accessCode) {
    return apiError('INVALID_REQUEST', 401, 'Invalid access code');
  }

  const cookieStore = await cookies();
  cookieStore.set('openmaic_access', crypto.randomUUID(), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7, // 7 days
    secure: process.env.NODE_ENV === 'production',
  });

  return apiSuccess({ valid: true });
}
