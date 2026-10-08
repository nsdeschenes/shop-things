import * as stylex from '@stylexjs/stylex';
import {queryOptions, useQuery} from '@tanstack/react-query';
import {useSyncExternalStore} from 'react';

import type {Application} from '../../application/controller';
import {colors} from '../../styles/colors.stylex';
import Button from '../button/button';

const styles = stylex.create({
  section: {gap: 12, display: 'flex', flexDirection: 'column', marginTop: 24},
  heading: {fontSize: 20, fontWeight: 600},
  text: {color: colors.textMuted, lineHeight: 1.5},
  list: {
    padding: 0,
    gap: 16,
    display: 'flex',
    flexDirection: 'column',
    listStyleType: 'none',
  },
  entry: {
    padding: 16,
    borderColor: colors.border,
    borderRadius: 8,
    borderStyle: 'solid',
    borderWidth: 1,
    gap: 8,
    display: 'flex',
    flexDirection: 'column',
  },
  path: {overflowWrap: 'anywhere'},
});

export default function MigrationSnapshots({application}: {application: Application}) {
  const state = useSyncExternalStore(application.subscribe, application.getState);
  const protection = useSyncExternalStore(
    application.protection.subscribe,
    application.protection.getState
  );
  const disabled =
    state.phase !== 'ready' ||
    state.mode !== 'live' ||
    Boolean(state.pendingFile) ||
    state.pendingTransition ||
    state.refreshingCustomers ||
    state.reconciling ||
    protection.frozen ||
    protection.saving;
  const query = useQuery(
    queryOptions({
      queryKey: ['migration-snapshots', state.database?.version],
      enabled: !disabled,
      retry: false,
      queryFn: async () => {
        const result = await application.listMigrationSnapshots();
        if (result.status !== 'success') {
          throw new Error(
            result.status === 'error'
              ? result.error.message
              : 'Migration snapshots could not be read. Try again.'
          );
        }

        return result.value;
      },
    }),
    application.queryClient
  );
  if (state.mode !== 'live' || state.phase !== 'ready') {
    return null;
  }

  return (
    <section aria-label="Migration snapshots" {...stylex.props(styles.section)}>
      <h2 {...stylex.props(styles.heading)}>Migration Snapshots</h2>
      <p {...stylex.props(styles.text)}>
        Recover committed data saved before a database update into a new copy. Your
        original database and snapshot stay unchanged.
      </p>
      <p {...stylex.props(styles.text)}>
        Installing an older app does not undo a database update. Changes saved after a
        snapshot are not included in that snapshot.
      </p>
      {query.isPending && <p role="status">Loading migration snapshots…</p>}
      {query.error && <p role="alert">{query.error.message}</p>}
      {query.data && query.data.snapshots.length === 0 && (
        <p>No migration snapshots saved.</p>
      )}
      {Boolean(query.data?.unavailableCount) && (
        <p role="alert">
          Some snapshot metadata could not be read. Check the backup folder before
          restoring.
        </p>
      )}
      <ul {...stylex.props(styles.list)}>
        {query.data?.snapshots.map(snapshot => (
          <li key={snapshot.snapshotId} {...stylex.props(styles.entry)}>
            <p {...stylex.props(styles.path)}>{snapshot.sourcePath}</p>
            <time dateTime={snapshot.createdAt}>
              {new Date(snapshot.createdAt).toLocaleString()}
            </time>
            <details>
              <summary>Database history</summary>
              <p {...stylex.props(styles.path)}>
                Saved history: {snapshot.sourceHistory.join(', ')}
              </p>
              <p {...stylex.props(styles.path)}>
                Update history: {snapshot.targetHistory.join(', ')}
              </p>
            </details>
            <Button
              disabled={disabled || query.isFetching}
              onClick={() => {
                void application.restoreMigrationSnapshot(snapshot.snapshotId);
              }}
            >
              Restore new copy
            </Button>
          </li>
        ))}
      </ul>
      <Button
        disabled={disabled || query.isFetching}
        onClick={() => {
          void query.refetch();
        }}
      >
        Refresh snapshots
      </Button>
    </section>
  );
}
