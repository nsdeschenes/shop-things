import {Menu} from '@base-ui/react/menu';
import * as stylex from '@stylexjs/stylex';
import {useRef, useSyncExternalStore} from 'react';

import type {Application} from '../../application/controller';
import {colors} from '../../styles/colors.stylex';
import {spacing} from '../../styles/spacing.stylex';
import Button from '../button/button';

const pathSeparator = /[\\/]/;
const styles = stylex.create({
  region: {padding: spacing.space20, backgroundColor: colors.surface, color: colors.text},
  row: {gap: spacing.space12, alignItems: 'center', display: 'flex', flexWrap: 'wrap'},
  menu: {
    padding: spacing.space12,
    backgroundColor: colors.surface,
    color: colors.text,
    zIndex: 20,
  },
  item: {padding: spacing.space10, display: 'block'},
  path: {overflowWrap: 'anywhere'},
});

export default function DatabaseActions({application}: {application: Application}) {
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
    <section aria-label="Database" {...stylex.props(styles.region)}>
      <div {...stylex.props(styles.row)}>
        <Menu.Root>
          <Menu.Trigger ref={menuTrigger} disabled={disabled}>
            Database
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner>
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
      {state.phase === 'ready' && !database?.available && (
        <section aria-label="Database setup">
          <h1>{database?.selectedPath ? 'Recover Database' : 'Set Up Your Database'}</h1>
          {database?.selectedPath && (
            <>
              <p>
                Failed remembered file:{' '}
                {database.selectedPath.split(pathSeparator).at(-1)}
              </p>
              <p {...stylex.props(styles.path)}>{database.selectedPath}</p>
            </>
          )}
          {database?.recoveryError && (
            <p role="alert">{database.recoveryError.message}</p>
          )}
          <p>Create a new database or open a saved database to work with customers.</p>
          <div {...stylex.props(styles.row)}>
            <Button disabled={disabled} onClick={() => run('create')}>
              Create database
            </Button>
            <Button disabled={disabled} onClick={() => run('open')}>
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
      {state.fileError && (
        <div role="alert">
          <p>{state.fileError}</p>
          <Button onClick={() => application.dismissFileError()}>Dismiss error</Button>
        </div>
      )}
      {state.fileSuccess && <p role="status">{state.fileSuccess}</p>}
      {state.pendingFile && <p role="status">Waiting for database operation…</p>}
    </section>
  );
}
