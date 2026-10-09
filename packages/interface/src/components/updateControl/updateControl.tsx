import {Popover} from '@base-ui/react/popover';
import {ArrowUpTrayIcon} from '@heroicons/react/24/outline';
import type {UpdateBridge, UpdateState} from '@shop-things/contract';
import * as stylex from '@stylexjs/stylex';
import {useEffect, useState} from 'react';

import {colors} from '../../styles/colors.stylex';
import Button from '../button/button';

const styles = stylex.create({
  icon: {height: 20, width: 20},
  badge: {borderRadius: 8, backgroundColor: colors.primary, height: 8, width: 8},
  popup: {
    padding: 20,
    borderColor: colors.border,
    borderRadius: 8,
    borderStyle: 'solid',
    borderWidth: 1,
    backgroundColor: colors.surface,
    boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
    color: colors.text,
    width: 300,
  },
  positioner: {zIndex: 110},
  title: {fontSize: 18, fontWeight: 600, marginBottom: 12},
  message: {marginBottom: 12},
  actions: {gap: 8, display: 'flex'},
});
const initial: UpdateState = {
  revision: 0,
  phase: 'idle',
  capabilityReasons: [],
  nextActions: ['check'],
};

export default function UpdateControl({updates}: {updates: UpdateBridge | null}) {
  const [state, setState] = useState(initial);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (!updates) {
      return;
    }

    function accept(next: UpdateState) {
      if (active) {
        setState(previous => (next.revision >= previous.revision ? next : previous));
      }
    }

    const stop = updates.onStateChanged(accept);
    void updates.getState({}).then(result => {
      if (result.status === 'success') {
        accept(result.value);
      }
    });
    return () => {
      active = false;
      stop();
    };
  }, [updates]);

  async function check() {
    setError(null);
    if (['idle', 'current', 'available', 'check-failed'].includes(state.phase)) {
      setState(previous => ({...previous, phase: 'checking'}));
    }

    const result = await updates?.check({});
    if (result?.status === 'success') {
      setState(previous =>
        result.value.revision >= previous.revision ? result.value : previous
      );
    } else {
      setState(previous => ({...previous, phase: 'check-failed', errorCode: 'NETWORK'}));
    }
  }

  async function attempt(operation: () => ReturnType<UpdateBridge['start']> | undefined) {
    setError(null);
    const result = await operation();
    if (result?.status === 'success') {
      setState(previous =>
        result.value.revision >= previous.revision ? result.value : previous
      );
    } else if (result?.status === 'error') {
      setError(result.error.message);
    }
  }

  const available = Boolean(state.candidateId);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={<Button />}
        aria-label="Check for updates"
        title="Check for updates"
        onClick={() => {
          void check();
        }}
      >
        <ArrowUpTrayIcon aria-hidden="true" {...stylex.props(styles.icon)} />
        {available && (
          <span aria-label="Update available" {...stylex.props(styles.badge)} />
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          sideOffset={8}
          align="end"
          {...stylex.props(styles.positioner)}
        >
          <Popover.Popup {...stylex.props(styles.popup)}>
            <Popover.Title {...stylex.props(styles.title)}>
              Application updates
            </Popover.Title>
            <p role="status" {...stylex.props(styles.message)}>
              {state.phase === 'checking'
                ? 'Checking…'
                : state.phase === 'current'
                  ? "You're up to date"
                  : state.phase === 'available'
                    ? `Version ${state.targetVersion} is available`
                    : state.phase === 'downloading'
                      ? `Downloading version ${state.targetVersion}…`
                      : state.phase === 'verifying'
                        ? 'Verifying the downloaded update…'
                        : state.phase === 'preparing'
                          ? 'Preparing customer work for the update…'
                          : state.phase === 'quiescent'
                            ? 'Customer work is safely paused.'
                            : state.phase === 'authenticating'
                              ? 'Approve the system authentication dialog to continue.'
                              : state.phase === 'installing'
                                ? 'Installing the update. Keep Shop Things open.'
                                : state.phase === 'reconciling'
                                  ? 'Checking the installed package state…'
                                  : state.phase === 'restarting'
                                    ? 'Update installed. Restarting Shop Things…'
                                    : state.phase === 'package-recovery'
                                      ? 'The package state needs system recovery. Customer work remains closed.'
                                      : state.phase === 'staged'
                                        ? 'Download verified. Installation is not available yet.'
                                        : state.phase === 'retryable-failure'
                                          ? state.errorCode === 'AUTHENTICATION'
                                            ? 'The update did not change the installed packages. Retry when ready.'
                                            : state.errorCode === 'VERIFICATION'
                                              ? 'Update verification failed. Retry to download a fresh copy.'
                                              : state.errorCode === 'STORAGE'
                                                ? 'Could not store the update. Check free disk space and retry.'
                                                : state.errorCode === 'RATE_LIMIT'
                                                  ? 'The release service has limited requests. Wait before retrying.'
                                                  : 'Could not download the update. Check your connection and retry.'
                                          : state.phase === 'check-failed'
                                            ? 'Could not check for updates. Try again.'
                                            : 'Check for a newer version of Shop Things.'}
            </p>
            {state.phase === 'downloading' && (
              <progress
                aria-label="Update download progress"
                max={1}
                value={state.progress ?? 0}
              />
            )}
            {error && <p role="alert">{error}</p>}
            {state.capabilityReasons.map(reason => (
              <p key={reason} {...stylex.props(styles.message)}>
                {reason}
              </p>
            ))}
            <div {...stylex.props(styles.actions)}>
              {state.phase === 'available' && (
                <Button
                  disabled={!state.nextActions.includes('update')}
                  onClick={() => {
                    const candidateId = state.candidateId;
                    if (candidateId) {
                      void attempt(() => updates?.start({candidateId}));
                    }
                  }}
                >
                  Update
                </Button>
              )}
              {state.phase === 'retryable-failure' &&
                state.nextActions.includes('retry') && (
                  <Button
                    onClick={() => {
                      const attemptId = state.attemptId;
                      if (attemptId) {
                        void attempt(() => updates?.retry({attemptId}));
                      }
                    }}
                  >
                    Retry
                  </Button>
                )}
              {state.phase === 'check-failed' && (
                <Button
                  onClick={() => {
                    void check();
                  }}
                >
                  Retry
                </Button>
              )}
              <Popover.Close render={<Button />}>Close</Popover.Close>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
