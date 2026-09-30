import * as stylex from '@stylexjs/stylex';
import type {QueryClient} from '@tanstack/react-query';
import {createRootRouteWithContext, Link, Outlet} from '@tanstack/react-router';
import {useSyncExternalStore} from 'react';

import type {Application} from '../application/controller';
import Button from '../components/button/button';
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
  actions: {gap: spacing.space10, display: 'flex', flexWrap: 'wrap'},
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
  return (
    <div {...stylex.props(styles.layout)}>
      <header {...stylex.props(styles.header)}>
        <Link to="/customers" {...stylex.props(styles.brand)}>
          <p {...stylex.props(styles.eyebrow)}>Customer records</p>
          <p {...stylex.props(styles.title)}>Shop Things</p>
        </Link>
        <div {...stylex.props(styles.actions)}>
          <Button disabled>Open database</Button>
          <Button disabled>Back up database</Button>
          <Button disabled>Restore backup</Button>
          <Button disabled>Export all customers</Button>
        </div>
      </header>
      <p {...stylex.props(styles.database)}>
        {state.mode === 'live'
          ? 'Live mode'
          : state.mode === 'preview'
            ? 'Browser preview — temporary data'
            : 'Application unavailable'}
        {state.database?.selectedPath && ` · ${state.database.selectedPath}`}
      </p>
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
        <Outlet />
      )}
    </div>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({component: RootLayout});
