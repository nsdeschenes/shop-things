import {Dialog} from '@base-ui/react/dialog';
import {ArrowPathIcon, CircleStackIcon, Cog6ToothIcon} from '@heroicons/react/24/outline';
import * as stylex from '@stylexjs/stylex';
import {Link, useBlocker, useRouter} from '@tanstack/react-router';
import {useEffect, useRef, useSyncExternalStore, type ReactNode} from 'react';

import type {Application} from '../../application/controller';
import {navigationTarget} from '../../application/protection';
import {breakpoints} from '../../styles/breakpoints.stylex';
import {colors} from '../../styles/colors.stylex';
import {controls} from '../../styles/controls.stylex';
import {spacing} from '../../styles/spacing.stylex';
import {typography} from '../../styles/typography.stylex';
import Button from '../button/button';
import DatabaseActions from '../databaseActions/databaseActions';
import LoadingOverlay from '../loadingOverlay/loadingOverlay';

interface ApplicationShellProps {
  application: Application;
  children: ReactNode;
}

const pathSeparator = /[\\/]/;
const styles = stylex.create({
  dialog: {
    padding: spacing.space24,
    borderColor: colors.border,
    borderStyle: 'solid',
    borderWidth: controls.borderWidth,
    backgroundColor: colors.surface,
    color: colors.text,
    position: 'fixed',
    transform: 'translate(-50%, -50%)',
    zIndex: 101,
    left: '50%',
    maxWidth: 400,
    top: '50%',
  },
  layout: {
    backgroundColor: colors.pageBackground,
    color: colors.text,
    minHeight: '100vh',
  },
  header: {
    gap: spacing.space24,
    paddingBlock: spacing.space12,
    paddingInline: {default: spacing.space24, [breakpoints.compact]: spacing.space16},
    alignItems: 'center',
    backgroundColor: colors.headerBackground,
    color: colors.onPrimary,
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  headerActions: {gap: spacing.space12, alignItems: 'center', display: 'flex'},
  refreshIcon: {height: 20, width: 20},
  databaseLink: {
    borderRadius: 6,
    gap: 10,
    paddingBlock: 8,
    paddingInline: 12,
    textDecoration: 'none',
    alignItems: 'center',
    backgroundColor: {
      default: 'rgba(255,255,255,0.09)',
      ':hover': 'rgba(255,255,255,0.16)',
    },
    color: 'inherit',
    display: 'flex',
    fontSize: 14,
    outlineOffset: 4,
    minWidth: 0,
  },
  databaseName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: 180,
  },
  databaseIcon: {flexShrink: 0, height: 16, width: 16},
  brand: {textDecoration: 'none', color: 'inherit'},
  eyebrow: {
    fontSize: typography.fontSizeSmall,
    fontWeight: typography.fontWeightSemibold,
    letterSpacing: 0,
  },
  title: {
    fontSize: 24,
    fontWeight: typography.fontWeightBold,
    letterSpacing: -0.8,
    lineHeight: 1.3,
  },
  database: {
    paddingBlock: spacing.space6,
    paddingInline: {default: spacing.space24, [breakpoints.compact]: spacing.space16},
    fontSize: typography.fontSizeSmall,
    overflowWrap: 'anywhere',
    borderBottomColor: colors.border,
    borderBottomStyle: 'solid',
    borderBottomWidth: controls.borderWidth,
  },
});

export default function ApplicationShell({application, children}: ApplicationShellProps) {
  const state = useSyncExternalStore(application.subscribe, application.getState);
  const protection = useSyncExternalStore(
    application.protection.subscribe,
    application.protection.getState
  );
  const refreshDisabled =
    state.phase !== 'ready' ||
    !state.database?.available ||
    Boolean(state.pendingFile) ||
    state.pendingTransition ||
    state.reconciling ||
    state.recoveryRequired ||
    state.refreshingCustomers ||
    protection.dirty ||
    protection.frozen ||
    protection.saving;
  const router = useRouter();
  const committedNavigation = useRef(false);

  useBlocker({
    shouldBlockFn: async ({next}) => {
      if (
        (application.getState().pendingFile ||
          application.getState().refreshingCustomers) &&
        !committedNavigation.current
      ) {
        return true;
      }

      const target = navigationTarget(next.pathname, next.search);
      const blocked = await application.protection.blockNavigation(target);
      if (blocked || !application.protection.getState().frozen) {
        return blocked;
      }

      // Resolve route code/loader failure before committing history or unmounting the draft.
      const matches = await router
        .preloadRoute({
          to: next.pathname,
          search: next.search,
          state: previous => ({
            ...previous,
            customerNavigationRead: application.protection.navigationReadToken(target),
          }),
        })
        .catch(() => undefined);

      if (!matches || matches.some(match => match.status === 'error')) {
        application.protection.navigationResolved(target, false);
        return true;
      }

      const destination = matches.at(-1)!;
      application.protection.navigationLoaded(
        target,
        navigationTarget(destination.pathname, destination.search)
      );
      return false;
    },
    enableBeforeUnload: () =>
      state.mode === 'preview' && application.protection.isDirty(),
  });
  useEffect(
    () =>
      router.subscribe('onResolved', event => {
        application.protection.navigationResolved(
          navigationTarget(event.toLocation.pathname, event.toLocation.search),
          !router.state.matches.some(match => match.status === 'error')
        );
      }),
    [application, router]
  );
  useEffect(
    () =>
      application.onSessionChanged(() => {
        committedNavigation.current = true;
        void router.navigate({to: '/customers', replace: true}).finally(() => {
          committedNavigation.current = false;
        });
      }),
    [application, router]
  );
  return (
    <div {...stylex.props(styles.layout)}>
      <Dialog.Root
        open={protection.confirmingDiscard}
        onOpenChange={open => {
          if (!open) {
            application.protection.answerDiscard(false);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Popup
            initialFocus={() => document.getElementById('draft-stay')}
            {...stylex.props(styles.dialog)}
          >
            <Dialog.Title>Discard Unsaved Changes?</Dialog.Title>
            <Dialog.Description>Your edits have not been saved.</Dialog.Description>
            <Button
              id="draft-stay"
              onClick={() => application.protection.answerDiscard(false)}
            >
              Stay
            </Button>
            <Button onClick={() => application.protection.answerDiscard(true)}>
              Discard
            </Button>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
      <header {...stylex.props(styles.header)}>
        <Link
          inert={Boolean(state.pendingFile || state.refreshingCustomers)}
          to="/customers"
          {...stylex.props(styles.brand)}
        >
          <p {...stylex.props(styles.eyebrow)}>Customer records</p>
          <p {...stylex.props(styles.title)}>Shop Things</p>
        </Link>
        {state.phase === 'ready' && state.database?.available && (
          <div {...stylex.props(styles.headerActions)}>
            <Button
              aria-label="Refresh customers"
              title={
                protection.dirty
                  ? 'Save or discard your edits before refreshing'
                  : 'Refresh customers'
              }
              disabled={refreshDisabled}
              onClick={() => {
                void application.refreshCustomers();
              }}
            >
              <ArrowPathIcon aria-hidden="true" {...stylex.props(styles.refreshIcon)} />
            </Button>
            <Link
              to="/settings/database"
              disabled={
                Boolean(state.pendingFile || state.refreshingCustomers) ||
                protection.frozen ||
                protection.saving
              }
              aria-label="Database settings"
              title={
                state.database.selectedPath?.split(pathSeparator).at(-1) ??
                'Temporary database'
              }
              {...stylex.props(styles.databaseLink)}
            >
              <CircleStackIcon
                aria-hidden="true"
                {...stylex.props(styles.databaseIcon)}
              />
              <span {...stylex.props(styles.databaseName)}>
                {state.database.selectedPath?.split(pathSeparator).at(-1) ??
                  'Temporary database'}
              </span>
              <Cog6ToothIcon aria-hidden="true" {...stylex.props(styles.databaseIcon)} />
            </Link>
          </div>
        )}
      </header>
      {state.mode !== 'live' && (
        <p {...stylex.props(styles.database)}>
          {state.mode === 'preview'
            ? 'Browser preview — temporary data'
            : 'Application unavailable'}
        </p>
      )}
      {state.phase === 'ready' && !state.database?.available && (
        <DatabaseActions application={application} />
      )}
      {state.refreshError && (
        <section role="alert">
          <p>{state.refreshError}</p>
          <Button
            disabled={refreshDisabled}
            onClick={() => {
              void application.refreshCustomers();
            }}
          >
            Retry refresh
          </Button>
        </section>
      )}
      {protection.error && <p role="alert">{protection.error}</p>}
      {state.mode === 'unavailable' ? (
        <p>
          Open Shop Things in Electron, or add ?preview=true to the browser URL for a
          temporary preview.
        </p>
      ) : state.phase === 'loading' ? null : state.phase === 'error' ? (
        <section role="alert">
          <p>{state.error}</p>
          <Button
            onClick={() => {
              void application.start();
            }}
          >
            Retry
          </Button>
        </section>
      ) : (
        <div
          inert={Boolean(state.pendingFile || state.refreshingCustomers)}
          aria-busy={Boolean(state.pendingFile || state.refreshingCustomers)}
        >
          {children}
        </div>
      )}
      {(state.phase === 'loading' || state.pendingFile || state.refreshingCustomers) && (
        <LoadingOverlay
          label={
            state.refreshingCustomers
              ? 'Refreshing customers'
              : state.pendingFile === 'importSaving'
                ? 'Backing up and adding customers'
                : state.pendingFile
                  ? 'Loading database'
                  : 'Loading application'
          }
        />
      )}
    </div>
  );
}
