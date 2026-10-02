import {Menu} from '@base-ui/react/menu';
import * as stylex from '@stylexjs/stylex';
import {useNavigate} from '@tanstack/react-router';
import {useRef, useSyncExternalStore} from 'react';

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
  headerRegion: {
    padding: 0,
    backgroundColor: 'transparent',
    color: 'inherit',
    maxWidth: '100%',
    minWidth: 0,
  },
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
  menu: {
    padding: spacing.space6,
    borderColor: colors.controlBorder,
    borderRadius: radii.large,
    borderStyle: 'solid',
    borderWidth: controls.borderWidth,
    backgroundColor: colors.surface,
    boxShadow: '0 6px 20px rgba(24, 63, 59, 0.14)',
    color: colors.text,
    minWidth: 220,
  },
  positioner: {zIndex: 20},
  item: {
    borderRadius: radii.button,
    outline: 'none',
    paddingBlock: spacing.space10,
    paddingInline: spacing.space12,
    backgroundColor: {
      default: 'transparent',
      ':hover:not([data-disabled])': colors.surfaceHover,
      ':is([data-highlighted]):not([data-disabled])': colors.surfaceHover,
    },
    color: {default: colors.text, ':is([data-disabled])': colors.textMuted},
    cursor: {default: 'pointer', ':is([data-disabled])': 'not-allowed'},
    display: 'block',
    fontSize: typography.fontSizeBody,
    lineHeight: 1.5,
  },
  path: {overflowWrap: 'anywhere'},
});

export default function DatabaseActions({application}: {application: Application}) {
  const navigate = useNavigate();
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const state = useSyncExternalStore(application.subscribe, application.getState);
  const protection = useSyncExternalStore(
    application.protection.subscribe,
    application.protection.getState
  );
  const disabled =
    state.phase !== 'ready' ||
    state.mode === 'unavailable' ||
    Boolean(state.pendingFile) ||
    state.pendingTransition ||
    state.reconciling ||
    protection.frozen ||
    protection.saving;
  const database = state.database;
  if (state.mode === 'preview') {
    return null;
  }

  function run(action: 'create' | 'open' | 'retry' | 'backup' | 'restore' | 'export') {
    void application.fileAction(action).then(() => {
      if (action === 'restore') {
        requestAnimationFrame(() => menuTrigger.current?.focus());
      }
    });
  }

  return (
    <section
      aria-label="Database"
      {...stylex.props(
        styles.region,
        database?.available ? styles.headerRegion : styles.setupRegion
      )}
    >
      {database?.available && (
        <div {...stylex.props(styles.row)}>
          <Menu.Root>
            <Menu.Trigger ref={menuTrigger} disabled={disabled} render={<Button />}>
              Database
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner sideOffset={6} {...stylex.props(styles.positioner)}>
                <Menu.Popup {...stylex.props(styles.menu)}>
                  <Menu.Item
                    disabled={disabled}
                    onClick={() => run('create')}
                    {...stylex.props(styles.item)}
                  >
                    Create database
                  </Menu.Item>
                  <Menu.Item
                    disabled={disabled}
                    onClick={() => run('open')}
                    {...stylex.props(styles.item)}
                  >
                    Open database
                  </Menu.Item>
                  <Menu.Item
                    disabled={disabled || !database?.available || state.recoveryRequired}
                    onClick={() => run('backup')}
                    {...stylex.props(styles.item)}
                  >
                    Back up database
                  </Menu.Item>
                  <Menu.Item
                    disabled={disabled}
                    onClick={() => run('restore')}
                    {...stylex.props(styles.item)}
                  >
                    Restore backup
                  </Menu.Item>
                  <Menu.Item
                    disabled={disabled || !database?.available || state.recoveryRequired}
                    onClick={() => run('export')}
                    {...stylex.props(styles.item)}
                  >
                    Export all customers
                  </Menu.Item>
                  <Menu.Item
                    disabled={disabled || !database?.available || state.recoveryRequired}
                    onClick={() => {
                      void application.prepareImport().then(result => {
                        if (result.status === 'success') {
                          void navigate({
                            to: '/customers/import',
                            search: {importId: result.value.importId},
                          });
                        } else if (result.status === 'error') {
                          application.toasts.error({title: result.error.message});
                        }
                      });
                    }}
                    {...stylex.props(styles.item)}
                  >
                    Import customers
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
          {database?.available && (
            <span>
              Active database: {database.selectedPath?.split(pathSeparator).at(-1)}
            </span>
          )}
          {database?.available && (
            <details>
              <summary>Full database path</summary>
              <p {...stylex.props(styles.path)}>{database.selectedPath}</p>
            </details>
          )}
        </div>
      )}
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
