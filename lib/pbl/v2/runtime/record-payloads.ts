import type {
  PBLEngagementEvent,
  PBLEvaluation,
  PBLChatMessage,
  PBLHandover,
  PBLInternalAssessment,
  PBLPendingTaskCompletion,
  PBLProficiencyAssessment,
  PBLProjectV2,
  PBLRuntimeEvent,
  PBLSubmission,
} from '@/lib/pbl/v2/types';
import type { PBLLearnerState } from './learner-state';

export const PBL_RUNTIME_PAYLOAD_VERSION = 1;

export type PBLRuntimeAttachment =
  | { kind: 'message'; message: PBLChatMessage }
  | {
      kind: 'thread_compaction';
      threadId: string;
      messages: PBLChatMessage[];
      earlierSummary?: string;
    }
  | { kind: 'submission'; submission: PBLSubmission }
  | { kind: 'evaluation'; evaluation: PBLEvaluation }
  | {
      kind: 'status';
      entityType: Extract<PBLRuntimeEvent, { kind: 'status_changed' }>['entityType'];
      entityId: string;
      milestone?: { internalAssessment?: PBLInternalAssessment };
      microtask?: {
        internalAssessment?: PBLInternalAssessment;
        completionReason?: string;
        engagement?: PBLProjectV2['milestones'][number]['microtasks'][number]['engagement'];
      };
    }
  | { kind: 'handover'; handover: PBLHandover }
  | { kind: 'pending_task_completion'; pendingTaskCompletion: PBLPendingTaskCompletion }
  | { kind: 'proficiency'; assessment: PBLProficiencyAssessment };

export interface PBLRuntimeEventRecordPayload {
  kind: 'pbl_runtime_event';
  payloadVersion: typeof PBL_RUNTIME_PAYLOAD_VERSION;
  event: PBLRuntimeEvent;
  attachment: PBLRuntimeAttachment | null;
  attachmentMissingReason?: string;
}

export interface PBLEngagementEventRecordPayload {
  kind: 'pbl_engagement_event';
  payloadVersion: typeof PBL_RUNTIME_PAYLOAD_VERSION;
  event: PBLEngagementEvent;
}

export interface PBLSnapshotRecordPayload {
  kind: 'pbl_snapshot';
  payloadVersion: typeof PBL_RUNTIME_PAYLOAD_VERSION;
  epoch: number;
  learnerState: PBLLearnerState;
  anchor: {
    lastRuntimeEventId?: string;
    lastEngagementEventId?: string;
    recordSeq?: number;
  };
  reason: 'backfill' | 'self_heal' | 'test';
}

export type PBLRuntimeStorePayload =
  | PBLRuntimeEventRecordPayload
  | PBLEngagementEventRecordPayload
  | PBLSnapshotRecordPayload;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function findMessage(
  project: PBLProjectV2,
  event: Extract<PBLRuntimeEvent, { kind: 'message_created' }>,
) {
  return project.threads
    .find((thread) => thread.agentId === event.threadId)
    ?.messages.find((message) => message.id === event.messageId);
}

function statusAttachment(
  project: PBLProjectV2,
  event: Extract<PBLRuntimeEvent, { kind: 'status_changed' }>,
): { attachment: PBLRuntimeAttachment | null; reason?: string } {
  if (event.entityType === 'project' || event.entityType === 'ui_phase') {
    return {
      attachment: { kind: 'status', entityType: event.entityType, entityId: event.entityId },
    };
  }
  const milestone =
    event.entityType === 'milestone'
      ? project.milestones.find((candidate) => candidate.id === event.entityId)
      : project.milestones.find((candidate) =>
          candidate.microtasks.some((microtask) => microtask.id === event.entityId),
        );
  if (!milestone) return { attachment: null, reason: 'milestone_not_found' };
  if (event.entityType === 'milestone') {
    return {
      attachment: {
        kind: 'status',
        entityType: 'milestone',
        entityId: event.entityId,
        milestone: { internalAssessment: clone(milestone.internalAssessment) },
      },
    };
  }
  const microtask = milestone.microtasks.find((candidate) => candidate.id === event.entityId);
  if (!microtask) return { attachment: null, reason: 'microtask_not_found' };
  return {
    attachment: {
      kind: 'status',
      entityType: 'microtask',
      entityId: event.entityId,
      microtask: {
        internalAssessment: clone(microtask.internalAssessment),
        completionReason: microtask.completionReason,
        engagement: clone(microtask.engagement),
      },
    },
  };
}

export function enrichPBLRuntimeEvent(
  project: PBLProjectV2,
  event: PBLRuntimeEvent,
): PBLRuntimeEventRecordPayload {
  const withAttachment = (
    attachment: PBLRuntimeAttachment | null,
    attachmentMissingReason?: string,
  ): PBLRuntimeEventRecordPayload => ({
    kind: 'pbl_runtime_event',
    payloadVersion: PBL_RUNTIME_PAYLOAD_VERSION,
    event: clone(event),
    attachment: clone(attachment),
    attachmentMissingReason,
  });

  switch (event.kind) {
    case 'message_created': {
      const message = findMessage(project, event);
      return message
        ? withAttachment({ kind: 'message', message })
        : withAttachment(null, 'message_not_found');
    }
    case 'thread_compacted': {
      const thread = project.threads.find((candidate) => candidate.agentId === event.threadId);
      return thread
        ? withAttachment({
            kind: 'thread_compaction',
            threadId: thread.agentId,
            messages: thread.messages,
            earlierSummary: thread.earlierSummary,
          })
        : withAttachment(null, 'thread_not_found');
    }
    case 'submission_created': {
      const submission = project.submissions.find(
        (candidate) => candidate.id === event.submissionId,
      );
      return submission
        ? withAttachment({ kind: 'submission', submission })
        : withAttachment(null, 'submission_not_found');
    }
    case 'evaluation_created': {
      const evaluation = project.evaluations.find(
        (candidate) => candidate.id === event.evaluationId,
      );
      return evaluation
        ? withAttachment({ kind: 'evaluation', evaluation })
        : withAttachment(null, 'evaluation_not_found');
    }
    case 'status_changed': {
      const { attachment, reason } = statusAttachment(project, event);
      return withAttachment(attachment, reason);
    }
    case 'handover_staged':
    case 'handover_consumed':
      return project.pendingHandover
        ? withAttachment({ kind: 'handover', handover: project.pendingHandover })
        : withAttachment(null, 'handover_not_found');
    case 'task_completion_staged':
      return project.pendingTaskCompletion
        ? withAttachment({
            kind: 'pending_task_completion',
            pendingTaskCompletion: project.pendingTaskCompletion,
          })
        : withAttachment(null, 'pending_task_completion_not_found');
    case 'proficiency_updated':
      return project.proficiencyAssessment
        ? withAttachment({ kind: 'proficiency', assessment: project.proficiencyAssessment })
        : withAttachment(null, 'proficiency_assessment_not_found');
    case 'project_reset':
    case 'task_completion_cleared':
    case 'tool_call_started':
    case 'tool_call_succeeded':
    case 'tool_call_failed':
      return withAttachment(null);
  }
}

export function pblEngagementRecordPayload(
  event: PBLEngagementEvent,
): PBLEngagementEventRecordPayload {
  return {
    kind: 'pbl_engagement_event',
    payloadVersion: PBL_RUNTIME_PAYLOAD_VERSION,
    event: clone(event),
  };
}

export function pblSnapshotRecordPayload(args: {
  epoch: number;
  learnerState: PBLLearnerState;
  anchor: PBLSnapshotRecordPayload['anchor'];
  reason: PBLSnapshotRecordPayload['reason'];
}): PBLSnapshotRecordPayload {
  return {
    kind: 'pbl_snapshot',
    payloadVersion: PBL_RUNTIME_PAYLOAD_VERSION,
    epoch: args.epoch,
    learnerState: clone(args.learnerState),
    anchor: { ...args.anchor },
    reason: args.reason,
  };
}
