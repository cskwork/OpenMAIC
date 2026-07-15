import { apiSuccess } from '@/lib/server/api-response';
import { isRenderServiceConfigured } from '@/lib/server/render-service';

export const dynamic = 'force-dynamic';

/**
 * Report whether one-click MP4 export is available. The export menu calls this
 * to decide between offering "Render MP4" (service configured) and only
 * "Download ZIP" (degrade). Never leaks the service URL to the client.
 */
export async function GET() {
  return apiSuccess({ enabled: isRenderServiceConfigured() });
}
