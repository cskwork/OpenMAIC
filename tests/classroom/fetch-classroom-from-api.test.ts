import { afterEach, describe, expect, it, vi } from 'vitest';

// Exercises the real fetchClassroomFromApi: the /api/classroom JSON boundary,
// the dynamic converter import, degradation on converter failure, and the
// rollback of conversion side effects through the shared ledger.
const mocks = vi.hoisted(() => ({
  convertMock: vi.fn(),
  removeAssetMock: vi.fn().mockResolvedValue(undefined),
}));
const { convertMock, removeAssetMock } = mocks;

vi.mock('@/lib/utils/stage-storage', () => ({
  saveStageData: vi.fn().mockResolvedValue(undefined),
  saveStageDataIncremental: vi.fn().mockResolvedValue({ failedChanges: [] }),
  loadStageData: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/media/convert-legacy-asset-refs', () => ({
  convertDocumentAssetRefs: (...args: unknown[]) => convertMock(...args),
}));
vi.mock('@/lib/media/asset-pool', () => ({
  removeAsset: (...args: unknown[]) => removeAssetMock(...args),
}));

import { fetchClassroomFromApi } from '@/lib/classroom/load-classroom';

const payload = {
  stage: { id: 'stage-1', name: 'Course', createdAt: 1, updatedAt: 2 },
  scenes: [],
};

function stubClassroomApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ success: true, classroom: payload })),
  );
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('fetchClassroomFromApi', () => {
  it('returns the converted payload with its fresh allocation list', async () => {
    stubClassroomApi();
    convertMock.mockResolvedValue({
      document: { ...payload, stage: { ...payload.stage, name: 'Converted' } },
      allocatedIds: ['ast_1'],
    });

    const result = await fetchClassroomFromApi('stage-1');

    expect(result?.stage.name).toBe('Converted');
    expect(result?.allocatedAssetIds).toEqual(['ast_1']);
  });

  it('degrades to the unconverted payload when conversion fails', async () => {
    stubClassroomApi();
    convertMock.mockRejectedValue(new Error('pool unavailable'));

    const result = await fetchClassroomFromApi('stage-1');

    expect(result?.stage.name).toBe('Course');
    expect(result?.allocatedAssetIds).toBeUndefined();
    expect(removeAssetMock).not.toHaveBeenCalled();
  });

  it('rolls back allocations when the load is superseded mid-conversion', async () => {
    stubClassroomApi();
    convertMock.mockImplementation(
      (_doc: unknown, _deps: unknown, shouldContinue?: () => boolean, ledger?: string[]) => {
        if (shouldContinue && !shouldContinue()) {
          ledger?.push('ast_stale');
          return Promise.reject(new Error('conversion aborted'));
        }
        return Promise.resolve({ document: payload, allocatedIds: ledger ?? [] });
      },
    );
    // Current at the pre-conversion gate, superseded by the time the
    // converter rechecks.
    let checks = 0;
    const guard = () => {
      checks += 1;
      return checks === 1;
    };

    const result = await fetchClassroomFromApi('stage-1', guard);

    expect(result?.stage.name).toBe('Course');
    expect(removeAssetMock).toHaveBeenCalledExactlyOnceWith('ast_stale');
  });

  it('returns null for an unsuccessful API response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    await expect(fetchClassroomFromApi('stage-1')).resolves.toBeNull();
    expect(convertMock).not.toHaveBeenCalled();
  });
});
