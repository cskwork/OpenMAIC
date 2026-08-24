/** Server-side agent runtime status probe. */
import { isAgentRuntimeEnabled } from '@/lib/config/feature-flags';

export const runtime = 'nodejs';

export async function GET() {
  return Response.json({ enabled: isAgentRuntimeEnabled() });
}
