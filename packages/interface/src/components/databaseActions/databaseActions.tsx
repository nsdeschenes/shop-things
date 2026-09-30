import {Menu} from '@base-ui/react/menu';
import * as stylex from '@stylexjs/stylex';
import {useSyncExternalStore} from 'react';

import type {Application} from '../../application/controller';
import {
  setPreviewOutcome,
  simulatePreviewRecovery,
  type PreviewOutcome,
} from '../../application/preview';
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
  const preview = state.mode === 'preview';
  function label(value: string) {
    return preview ? `${value} (simulation)` : value;
  }

  function run(action: 'create' | 'open' | 'retry') {
    void application.fileAction(action);
  }

  return (
    <section aria-label="Database" {...stylex.props(styles.region)}>
      <div {...stylex.props(styles.row)}>
        <Menu.Root>
          <Menu.Trigger disabled={disabled}>Database</Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner>
              <Menu.Popup {...stylex.props(styles.menu)}>
                <Menu.Item
                  disabled={disabled}
                  onClick={() => run('create')}
                  {...stylex.props(styles.item)}
                >
                  {label('Create database')}
                </Menu.Item>
                <Menu.Item
                  disabled={disabled}
                  onClick={() => run('open')}
                  {...stylex.props(styles.item)}
                >
                  {label('Open database')}
                </Menu.Item>
                <Menu.Item disabled {...stylex.props(styles.item)}>
                  {label('Back up database')}
                </Menu.Item>
                <Menu.Item disabled {...stylex.props(styles.item)}>
                  {label('Restore backup')}
                </Menu.Item>
                <Menu.Item disabled {...stylex.props(styles.item)}>
                  {label('Export all customers')}
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
        {preview && (
          <label>
            Simulation result{' '}
            <select
              disabled={disabled}
              defaultValue="success"
              onChange={event => {
                const client = application.getClient();
                if (client) {
                  setPreviewOutcome(client, event.target.value as PreviewOutcome);
                }
              }}
            >
              <option value="success">Success</option>
              <option value="cancelled">Cancel</option>
              <option value="error">File error</option>
            </select>
          </label>
        )}
      </div>
      {preview && (
        <Button
          disabled={disabled}
          onClick={() => {
            const client = application.getClient();
            if (client) {
              simulatePreviewRecovery(client);
            }
          }}
        >
          Simulate remembered-file failure
        </Button>
      )}
      {state.phase === 'ready' && !database?.available && (
        <section aria-label="Database setup">
          <h1>{database?.selectedPath ? 'Recover database' : 'Set up your database'}</h1>
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
              {label('Create database')}
            </Button>
            <Button disabled={disabled} onClick={() => run('open')}>
              {label('Open database')}
            </Button>
            {database?.selectedPath && (
              <Button disabled={disabled} onClick={() => run('retry')}>
                {label('Retry remembered database')}
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
      {state.pendingFile && (
        <p role="status">
          {preview ? 'Simulating database operation…' : 'Waiting for database operation…'}
        </p>
      )}
    </section>
  );
}
