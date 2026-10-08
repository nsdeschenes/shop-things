import {randomUUID} from 'node:crypto';

import type {DraftRequest, DraftResolution} from '@shop-things/contract';
import {draftReplySchema} from '@shop-things/contract/schemas';

export interface DraftParticipant {
  documentId: string;
  prepare(request: DraftRequest): void;
  resolve(resolution: DraftResolution): void;
}

export interface DraftLease {
  hasUnsavedDraft: boolean;
  assertCurrent(): void;
  finish(outcome: DraftResolution['outcome']): void;
}

interface PendingPreparation {
  participant: DraftParticipant;
  request: DraftRequest;
  replied: boolean;
  complete(hasUnsavedDraft: boolean): void;
  fail(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class DraftCoordinator {
  private participant: DraftParticipant | null = null;
  private pending: PendingPreparation | null = null;
  constructor(private readonly timeoutMs = 1000) {}

  register(participant: DraftParticipant): () => void {
    this.abort();
    this.participant = participant;
    return () => {
      if (this.participant === participant) {
        this.abort();
        this.participant = null;
      }
    };
  }

  reply(participant: DraftParticipant, payload: unknown): boolean {
    const pending = this.pending;
    if (!pending || pending.participant !== participant || pending.replied) {
      return false;
    }

    const parsed = draftReplySchema.safeParse(payload);
    if (!parsed.success) {
      this.abort();
      return false;
    }

    const reply = parsed.data;
    if (
      reply.requestId !== pending.request.requestId ||
      reply.documentId !== pending.request.documentId
    ) {
      return false;
    }

    pending.replied = true;
    clearTimeout(pending.timer);
    pending.complete(reply.hasUnsavedDraft);
    return true;
  }

  async prepare(): Promise<DraftLease> {
    const participant = this.participant;
    if (!participant || this.pending) {
      throw new Error('The current editor cannot prepare a protected transition');
    }

    const request = {requestId: randomUUID(), documentId: participant.documentId};
    let pending!: PendingPreparation;
    const hasUnsavedDraft = await new Promise<boolean>((complete, fail) => {
      pending = {
        participant,
        request,
        replied: false,
        complete,
        fail,
        timer: setTimeout(() => {
          this.abort();
        }, this.timeoutMs),
      };
      this.pending = pending;
      try {
        participant.prepare(request);
      } catch {
        this.abort();
      }
    });

    return {
      hasUnsavedDraft,
      assertCurrent: () => {
        if (this.pending !== pending) {
          throw new Error('The prepared editor document changed');
        }
      },
      finish: outcome => {
        this.finish(pending, outcome);
      },
    };
  }

  private abort(): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }

    pending.fail(new Error('The editor did not complete draft preparation'));
    this.finish(pending, 'aborted');
  }

  private finish(pending: PendingPreparation, outcome: DraftResolution['outcome']): void {
    if (this.pending !== pending) {
      return;
    }

    this.pending = null;
    clearTimeout(pending.timer);

    try {
      pending.participant.resolve({...pending.request, outcome});
    } catch {
      /* The document may already be gone. */
    }
  }
}
