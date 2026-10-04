import * as stylex from '@stylexjs/stylex';
import {useSyncExternalStore} from 'react';

import type {Application} from '../../application/controller';
import {breakpoints} from '../../styles/breakpoints.stylex';
import {colors} from '../../styles/colors.stylex';
import {controls} from '../../styles/controls.stylex';
import {radii} from '../../styles/radii.stylex';
import {spacing} from '../../styles/spacing.stylex';
import {typography} from '../../styles/typography.stylex';
import Button from '../button/button';

const pathSeparator = /[\\/]/;
const styles = stylex.create({
  region: {padding: spacing.space20, backgroundColor: colors.surface, color: colors.text},
  setupRegion: {
    padding: {default: spacing.space28, [breakpoints.compact]: spacing.space16},
    backgroundColor: colors.pageBackground,
  },
  setup: {
    padding: {default: spacing.space28, [breakpoints.compact]: spacing.space20},
    borderColor: colors.border,
    borderRadius: radii.large,
    borderStyle: 'solid',
    borderWidth: controls.borderWidth,
    gap: spacing.space20,
    marginInline: 'auto',
    backgroundColor: colors.surface,
    display: 'flex',
    flexDirection: 'column',
    maxWidth: 760,
  },
  heading: {
    fontSize: typography.fontSizeBrand,
    fontWeight: typography.fontWeightBold,
    letterSpacing: -0.6,
    lineHeight: 1.2,
  },
  file: {
    padding: spacing.space16,
    borderColor: colors.border,
    borderRadius: radii.panel,
    borderStyle: 'solid',
    borderWidth: controls.borderWidth,
    gap: spacing.space8,
    backgroundColor: colors.surfaceHover,
    display: 'flex',
    flexDirection: 'column',
  },
  fileName: {fontWeight: typography.fontWeightSemibold},
  filePath: {
    color: colors.textMuted,
    fontSize: typography.fontSizeSmall,
    lineHeight: 1.5,
  },
  recoveryError: {
    borderInlineStartColor: colors.errorText,
    borderInlineStartStyle: 'solid',
    borderInlineStartWidth: 3,
    color: colors.errorText,
    lineHeight: 1.5,
    paddingInlineStart: spacing.space16,
  },
  description: {color: colors.textMuted, lineHeight: 1.5},
  actions: {
    paddingBlockStart: spacing.space20,
    borderTopColor: colors.border,
    borderTopStyle: 'solid',
    borderTopWidth: controls.borderWidth,
  },
  row: {gap: spacing.space12, alignItems: 'center', display: 'flex', flexWrap: 'wrap'},
  path: {overflowWrap: 'anywhere'},
});

export default function DatabaseActions({application}: {application: Application}) {
  const state = useSyncExternalStore(application.subscribe, application.getState);
  const protection = useSyncExternalStore(
    application.protection.subscribe,
    application.protection.getState
  );
  const disabled =
    state.phase !== 'ready' ||
    state.mode === 'unavailable' ||
    Boolean(state.pendingFile) ||
    state.refreshingCustomers ||
    state.pendingTransition ||
    state.reconciling ||
    protection.frozen ||
    protection.saving;
  const database = state.database;
  if (state.mode === 'preview') {
    return null;
  }

  function run(action: 'create' | 'open' | 'retry') {
    void application.fileAction(action);
  }

  return (
    <section aria-label="Database" {...stylex.props(styles.region, styles.setupRegion)}>
      {state.phase === 'ready' && !database?.available && (
        <section aria-label="Database setup" {...stylex.props(styles.setup)}>
          <h1 {...stylex.props(styles.heading)}>
            {database?.selectedPath ? 'Recover Database' : 'Set Up Your Database'}
          </h1>
          {database?.selectedPath && (
            <div {...stylex.props(styles.file)}>
              <p {...stylex.props(styles.fileName)}>
                Failed remembered file:{' '}
                {database.selectedPath.split(pathSeparator).at(-1)}
              </p>
              <p {...stylex.props(styles.path, styles.filePath)}>
                {database.selectedPath}
              </p>
            </div>
          )}
          {database?.recoveryError && (
            <p role="alert" {...stylex.props(styles.recoveryError)}>
              {database.recoveryError.message}
            </p>
          )}
          <p {...stylex.props(styles.description)}>
            Create a new database or open a saved database to work with customers.
          </p>
          <div {...stylex.props(styles.row, styles.actions)}>
            <Button variant="primary" disabled={disabled} onClick={() => run('create')}>
              Create database
            </Button>
            <Button variant="primary" disabled={disabled} onClick={() => run('open')}>
              Open database
            </Button>
            {database?.selectedPath && (
              <Button disabled={disabled} onClick={() => run('retry')}>
                Retry remembered database
              </Button>
            )}
          </div>
        </section>
      )}
    </section>
  );
}
