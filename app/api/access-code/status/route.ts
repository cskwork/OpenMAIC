import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function GET() {
  const accessCode = process.env.ACCESS_CODE;
  const enabled = !!accessCode;

  let authenticated = false;
  if (enabled) {
    const cookieStore = await cookies();
    authenticated = cookieStore.has('openmaic_access');
  }

  return NextResponse.json({ enabled, authenticated });
}
