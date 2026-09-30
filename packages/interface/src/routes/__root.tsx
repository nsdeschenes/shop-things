import {Dialog} from '@base-ui/react/dialog';
import * as stylex from '@stylexjs/stylex';
import type {QueryClient} from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  Link,
  Outlet,
  useBlocker,
  useRouter,
} from '@tanstack/react-router';
import {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {z} from 'zod';

import type {Application} from '../application/controller';
import {navigationTarget} from '../application/protection';
import Button from '../components/button/button';
import DatabaseActions from '../components/databaseActions/databaseActions';
import {breakpoints} from '../styles/breakpoints.stylex';
import {colors} from '../styles/colors.stylex';
import {controls} from '../styles/controls.stylex';
import {spacing} from '../styles/spacing.stylex';
import {typography} from '../styles/typography.stylex';

interface RouterContext {
  queryClient: QueryClient;
  application: Application;
}

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
    paddingBlock: spacing.space20,
    paddingInline: {default: spacing.space24, [breakpoints.compact]: spacing.space16},
    alignItems: 'center',
    backgroundColor: colors.headerBackground,
    color: colors.onPrimary,
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  brand: {textDecoration: 'none', color: 'inherit'},
  eyebrow: {
    fontSize: typography.fontSizeSmall,
    fontWeight: typography.fontWeightSemibold,
    letterSpacing: 1.2,
  },
  title: {
    fontSize: typography.fontSizeBrand,
    fontWeight: typography.fontWeightBold,
    letterSpacing: -0.8,
    lineHeight: 1.3,
  },
  database: {
    paddingBlock: spacing.space12,
    paddingInline: {default: spacing.space24, [breakpoints.compact]: spacing.space16},
    fontSize: typography.fontSizeSmall,
    overflowWrap: 'anywhere',
    borderBottomColor: colors.border,
    borderBottomStyle: 'solid',
    borderBottomWidth: controls.borderWidth,
  },
});

function RootLayout() {
  const {application} = Route.useRouteContext();
  const state = useSyncExternalStore(application.subscribe, application.getState);
  const protection = useSyncExternalStore(
    application.protection.subscribe,
    application.protection.getState
  );
  const router = useRouter();
  const committedNavigation = useRef(false);
  const [retainedView, setRetainedView] = useState(false);
  if (!retainedView && state.phase === 'ready' && state.database?.available) {
    setRetainedView(true);
  }

  useBlocker({
    shouldBlockFn: async ({next}) => {
      if (application.getState().pendingFile && !committedNavigation.current) {
        return true;
      }

      const target = navigationTarget(next.pathname, next.search);
      const blocked = await application.protection.blockNavigation(target);
      if (blocked || !application.protection.getState().frozen) {
        return blocked;
      }

      // Resolve route code/loader failure before committing history or unmounting the draft.
      const matches = await router.preloadRoute({to: next.pathname, search: next.search});
      if (!matches || matches.some(match => match.status === 'error')) {
        application.protection.navigationResolved(target, false);
        return true;
      }

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
        void router
          .navigate({to: '/customers', search: {}, replace: true})
          .finally(() => {
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
      <header inert={Boolean(state.pendingFile)} {...stylex.props(styles.header)}>
        <Link
          to="/customers"
          search={previous => previous}
          {...stylex.props(styles.brand)}
        >
          <p {...stylex.props(styles.eyebrow)}>Customer records</p>
          <p {...stylex.props(styles.title)}>Shop Things</p>
        </Link>
      </header>
      <p {...stylex.props(styles.database)}>
        {state.mode === 'live'
          ? 'Live mode'
          : state.mode === 'preview'
            ? 'Browser preview — temporary data'
            : 'Application unavailable'}
      </p>
      <DatabaseActions application={application} />
      {protection.error && <p role="alert">{protection.error}</p>}
      {state.mode === 'unavailable' ? (
        <p>
          Open Shop Things in Electron, or add ?preview=true to the browser URL for a
          temporary preview.
        </p>
      ) : state.phase === 'loading' ? (
        <p role="status">Connecting to the application…</p>
      ) : state.phase === 'error' ? (
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
        <div inert={Boolean(state.pendingFile)} aria-busy={Boolean(state.pendingFile)}>
          {retainedView && <Outlet />}
        </div>
      )}
    </div>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  validateSearch: z.object({q: z.string().optional().catch(undefined)}),
  component: RootLayout,
});
