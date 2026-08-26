/** Server-side agent runtime status probe. */
import { isAgentRuntimeConfigured } from '@/lib/config/feature-flags';

export const runtime = 'nodejs';

export async function GET() {
  // Intentionally no materials flag: isAgentMaterialsEnabled does not exist in this repo.
  return Response.json({ enabled: isAgentRuntimeConfigured() });
}
