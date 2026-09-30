import {Dialog} from '@base-ui/react/dialog';
import {Menu} from '@base-ui/react/menu';
import * as stylex from '@stylexjs/stylex';
import {useState, useSyncExternalStore} from 'react';

import type {Application} from '../../application/controller';
import {
  setPreviewOutcome,
  simulatePreviewRecovery,
  type PreviewOutcome,
} from '../../application/preview';
import {colors} from '../../styles/colors.stylex';
import {radii} from '../../styles/radii.stylex';
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
  dialog: {
    padding: spacing.space24,
    borderRadius: radii.panel,
    backgroundColor: colors.surface,
    color: colors.text,
    position: 'fixed',
    transform: 'translate(-50%, -50%)',
    zIndex: 30,
    left: '50%',
    top: '50%',
    width: 'min(440px, 90vw)',
  },
  dialogActions: {gap: spacing.space12, display: 'flex', marginTop: spacing.space20},
  path: {overflowWrap: 'anywhere'},
});

export default function DatabaseActions({application}: {application: Application}) {
  const [restoreExplanation, setRestoreExplanation] = useState(false);
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

  function run(action: 'create' | 'open' | 'retry' | 'backup' | 'export') {
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
                <Menu.Item
                  disabled={disabled || !database?.available || state.recoveryRequired}
                  onClick={() => run('backup')}
                  {...stylex.props(styles.item)}
                >
                  {label('Back up database')}
                </Menu.Item>
                <Menu.Item
                  disabled={disabled}
                  onClick={() => setRestoreExplanation(true)}
                  {...stylex.props(styles.item)}
                >
                  {label('Restore backup')}
                </Menu.Item>
                <Menu.Item
                  disabled={disabled || !database?.available || state.recoveryRequired}
                  onClick={() => run('export')}
                  {...stylex.props(styles.item)}
                >
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
      <Dialog.Root open={restoreExplanation} onOpenChange={setRestoreExplanation}>
        <Dialog.Portal>
          <Dialog.Popup
            initialFocus={() => document.getElementById('restore-cancel')}
            {...stylex.props(styles.dialog)}
          >
            <Dialog.Title>{label('Restore backup into a separate file')}</Dialog.Title>
            <Dialog.Description>
              Choose a backup, then a new destination. The restored database opens when
              complete. Your backup and previous working database are preserved. Existing
              destination files cannot be replaced.
              {preview &&
                ' This simulation uses temporary saved data and opens no native file pickers.'}
            </Dialog.Description>
            <div {...stylex.props(styles.dialogActions)}>
              <Button id="restore-cancel" onClick={() => setRestoreExplanation(false)}>
                Cancel
              </Button>
              <Button
                disabled={disabled}
                onClick={() => {
                  setRestoreExplanation(false);
                  void application.fileAction('restore');
                }}
              >
                {label('Continue')}
              </Button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
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
