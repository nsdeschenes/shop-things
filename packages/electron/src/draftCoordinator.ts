import {randomUUID} from 'node:crypto';

import type {DraftRequest, DraftResolution} from '@shop-things/contract';
import {draftReplySchema} from '@shop-things/contract/schemas';
import {Deferred, Effect, Exit} from 'effect';

import {runBoundary} from './effectBoundary.js';

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
  reply: Deferred.Deferred<boolean, Error>;
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
    Deferred.doneUnsafe(pending.reply, Effect.succeed(reply.hasUnsavedDraft));
    return true;
  }

  prepare(): Promise<DraftLease> {
    return runBoundary(this.prepareEffect());
  }

  prepareEffect(): Effect.Effect<DraftLease, Error> {
    return Effect.uninterruptibleMask(restore =>
      Effect.gen({self: this}, function* () {
        const participant = this.participant;
        if (!participant || this.pending) {
          return yield* Effect.fail(
            new Error('The current editor cannot prepare a protected transition')
          );
        }

        const pending: PendingPreparation = {
          participant,
          request: {requestId: randomUUID(), documentId: participant.documentId},
          replied: false,
          reply: Deferred.makeUnsafe<boolean, Error>(),
        };
        this.pending = pending;
        try {
          participant.prepare(pending.request);
        } catch {
          this.abort();
        }

        const waiting = Deferred.await(pending.reply).pipe(
          Effect.timeoutOrElse({
            duration: this.timeoutMs,
            orElse: () =>
              Effect.sync(() => {
                this.abort();
              }).pipe(Effect.andThen(Deferred.await(pending.reply))),
          })
        );
        const hasUnsavedDraft = yield* restore(waiting).pipe(
          Effect.onExit(exit =>
            Effect.sync(() => {
              if (Exit.isFailure(exit) && this.pending === pending) {
                this.abort();
              }
            })
          )
        );
        return {
          hasUnsavedDraft,
          assertCurrent: () => {
            if (this.pending !== pending) {
              throw new Error('The prepared editor document changed');
            }
          },
          finish: outcome => this.finish(pending, outcome),
        };
      })
    );
  }

  private abort(): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }

    Deferred.doneUnsafe(
      pending.reply,
      Effect.fail(new Error('The editor did not complete draft preparation'))
    );
    this.finish(pending, 'aborted');
  }

  private finish(pending: PendingPreparation, outcome: DraftResolution['outcome']): void {
    if (this.pending !== pending) {
      return;
    }

    this.pending = null;
    try {
      pending.participant.resolve({...pending.request, outcome});
    } catch {}
  }
}
