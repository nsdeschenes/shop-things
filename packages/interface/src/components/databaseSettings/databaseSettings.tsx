import {
  CircleStackIcon,
  ShieldCheckIcon,
  ArrowDownTrayIcon,
  ChevronRightIcon,
  CheckIcon,
  ArrowLeftIcon,
} from '@heroicons/react/24/outline';
import * as stylex from '@stylexjs/stylex';
import {Link, useNavigate} from '@tanstack/react-router';
import {useRef, useSyncExternalStore} from 'react';

import type {Application} from '../../application/controller';
import {colors} from '../../styles/colors.stylex';
import Button from '../button/button';
import buttonStyles from '../button/buttonStyles';
import MigrationSnapshots from '../migrationSnapshots/migrationSnapshots';

const pathSeparator = /[\\/]/;
const styles = stylex.create({
  page: {
    marginInline: 'auto',
    paddingBlock: 36,
    paddingInline: {default: 32, '@media (max-width: 700px)': 20},
    maxWidth: 1120,
  },
  pageIntro: {marginBottom: 28},
  back: {marginBottom: 20, width: 'fit-content'},
  heading: {
    fontSize: {default: 34, '@media (max-width: 700px)': 28},
    fontWeight: 600,
    letterSpacing: -1.1,
    lineHeight: 1.2,
    marginBottom: 8,
  },
  description: {color: colors.textMuted, fontSize: 14, lineHeight: 1.6, maxWidth: 560},
  title: {fontSize: 20, fontWeight: 600, letterSpacing: -0.4, marginBottom: 8},
  spread: {
    gap: 16,
    alignItems: 'center',
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  active: {
    padding: {default: 32, '@media (max-width: 700px)': 22},
    borderColor: '#c9dccf',
    borderRadius: 12,
    borderStyle: 'solid',
    borderWidth: 1,
    backgroundColor: '#e2efe5',
  },
  identity: {gap: 20, alignItems: 'center', display: 'flex', minWidth: 0},
  fileSymbol: {
    padding: 16,
    borderColor: '#c9dccf',
    borderRadius: 14,
    borderStyle: 'solid',
    borderWidth: 1,
    backgroundColor: colors.surface,
    color: colors.primary,
    display: {default: 'flex', '@media (max-width: 500px)': 'none'},
    flexShrink: 0,
  },
  largeIcon: {height: 32, width: 32},
  icon: {flexShrink: 0, height: 20, width: 20},
  smallIcon: {flexShrink: 0, height: 16, width: 16},
  fileLabel: {color: colors.textMuted, fontSize: 13, marginBottom: 4},
  file: {
    fontSize: {default: 28, '@media (max-width: 700px)': 22},
    fontWeight: 600,
    letterSpacing: -0.7,
    lineHeight: 1.25,
    overflowWrap: 'anywhere',
  },
  badge: {
    gap: 5,
    alignItems: 'center',
    color: colors.successText,
    display: 'inline-flex',
    fontSize: 13,
    fontWeight: 500,
    whiteSpace: 'nowrap',
  },
  fileFooter: {
    gap: 20,
    alignItems: 'flex-start',
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    borderTopColor: '#c9dccf',
    borderTopStyle: 'solid',
    borderTopWidth: 1,
    marginTop: 26,
    paddingTop: 22,
  },
  path: {
    color: colors.textMuted,
    display: 'block',
    fontSize: 13,
    lineHeight: 1.7,
    overflowWrap: 'anywhere',
    marginTop: 8,
  },
  detail: {
    color: colors.secondaryText,
    cursor: 'pointer',
    fontSize: 13,
    maxWidth: 560,
    paddingTop: 8,
  },
  columns: {
    gap: 28,
    display: 'grid',
    gridTemplateColumns: {default: '1fr 1fr', '@media (max-width: 700px)': '1fr'},
    marginTop: 28,
  },
  group: {
    borderColor: colors.border,
    borderRadius: 10,
    borderStyle: 'solid',
    borderWidth: 1,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  groupHeader: {padding: 24, minHeight: 138, paddingBottom: 20},
  groupTitle: {
    gap: 10,
    alignItems: 'center',
    color: colors.primary,
    display: 'flex',
    marginBottom: 10,
  },
  actionLink: {
    borderColor: colors.border,
    borderStyle: 'solid',
    borderWidth: 0,
    gap: 12,
    paddingBlock: 16,
    paddingInline: 24,
    alignItems: 'center',
    backgroundColor: {default: 'transparent', ':hover:not(:disabled)': colors.rowHover},
    color: colors.text,
    cursor: {default: 'pointer', ':disabled': 'not-allowed'},
    display: 'flex',
    fontSize: 14,
    fontWeight: 500,
    justifyContent: 'space-between',
    opacity: {default: 1, ':disabled': 0.5},
    outlineColor: colors.focusRing,
    outlineOffset: -3,
    textAlign: 'left',
    borderTopWidth: 1,
    width: '100%',
  },
  actions: {gap: 10, display: 'flex', flexWrap: 'wrap'},
});

export default function DatabaseSettings({application}: {application: Application}) {
  const state = useSyncExternalStore(application.subscribe, application.getState);
  const protection = useSyncExternalStore(
    application.protection.subscribe,
    application.protection.getState
  );
  const navigate = useNavigate();
  const restoreButton = useRef<HTMLButtonElement>(null);
  const database = state.database;
  const filename =
    database?.selectedPath?.split(pathSeparator).at(-1) ?? 'Temporary database';
  const disabled =
    state.phase !== 'ready' ||
    state.mode !== 'live' ||
    Boolean(state.pendingFile) ||
    state.refreshingCustomers ||
    state.pendingTransition ||
    state.reconciling ||
    protection.frozen ||
    protection.saving;
  const currentDisabled = disabled || !database?.available || state.recoveryRequired;

  function run(action: 'create' | 'open' | 'backup' | 'restore' | 'export') {
    void application.fileAction(action).then(() => {
      if (action === 'restore') {
        requestAnimationFrame(() => restoreButton.current?.focus());
      }
    });
  }

  function importCustomers() {
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
  }

  if (!database?.available) {
    return null;
  }

  return (
    <main {...stylex.props(styles.page)}>
      <Link to="/customers" {...stylex.props(buttonStyles.base, styles.back)}>
        <ArrowLeftIcon aria-hidden="true" {...stylex.props(styles.smallIcon)} />
        Back to customers
      </Link>
      <div {...stylex.props(styles.pageIntro)}>
        <h1 {...stylex.props(styles.heading)}>Database Settings</h1>
        <p {...stylex.props(styles.description)}>
          Your customer records, backups, and file transfers.
        </p>
      </div>
      <section aria-label="Active database" {...stylex.props(styles.active)}>
        <div {...stylex.props(styles.spread)}>
          <div {...stylex.props(styles.identity)}>
            <span {...stylex.props(styles.fileSymbol)}>
              <CircleStackIcon aria-hidden="true" {...stylex.props(styles.largeIcon)} />
            </span>
            <div>
              <h2 {...stylex.props(styles.fileLabel)}>Active Database</h2>
              <p {...stylex.props(styles.file)}>{filename}</p>
            </div>
          </div>
          <span {...stylex.props(styles.badge)}>
            <CheckIcon aria-hidden="true" {...stylex.props(styles.smallIcon)} />
            {state.recoveryRequired ? 'Recovery required' : 'Database open'}
          </span>
        </div>
        <div {...stylex.props(styles.fileFooter)}>
          {database.selectedPath ? (
            <details {...stylex.props(styles.detail)}>
              <summary>File location</summary>
              <p {...stylex.props(styles.path)}>{database.selectedPath}</p>
            </details>
          ) : (
            <p {...stylex.props(styles.description)}>
              Temporary browser data. File actions are available in the desktop app.
            </p>
          )}
          <div {...stylex.props(styles.actions)}>
            <Button variant="primary" disabled={disabled} onClick={() => run('open')}>
              Open database
            </Button>
            <Button disabled={disabled} onClick={() => run('create')}>
              Create database
            </Button>
          </div>
        </div>
      </section>
      <div {...stylex.props(styles.columns)}>
        <section {...stylex.props(styles.group)}>
          <div {...stylex.props(styles.groupHeader)}>
            <div {...stylex.props(styles.groupTitle)}>
              <ShieldCheckIcon aria-hidden="true" {...stylex.props(styles.icon)} />
              <h2 {...stylex.props(styles.title)}>Backups</h2>
            </div>
            <p {...stylex.props(styles.description)}>
              Save a copy of your database, or open a restored copy.
            </p>
          </div>
          <button
            disabled={currentDisabled}
            onClick={() => run('backup')}
            {...stylex.props(styles.actionLink)}
          >
            Back up database
            <ChevronRightIcon aria-hidden="true" {...stylex.props(styles.smallIcon)} />
          </button>
          <button
            ref={restoreButton}
            disabled={disabled}
            onClick={() => run('restore')}
            {...stylex.props(styles.actionLink)}
          >
            Restore backup
            <ChevronRightIcon aria-hidden="true" {...stylex.props(styles.smallIcon)} />
          </button>
        </section>
        <section {...stylex.props(styles.group)}>
          <div {...stylex.props(styles.groupHeader)}>
            <div {...stylex.props(styles.groupTitle)}>
              <ArrowDownTrayIcon aria-hidden="true" {...stylex.props(styles.icon)} />
              <h2 {...stylex.props(styles.title)}>Customer Files</h2>
            </div>
            <p {...stylex.props(styles.description)}>
              Review an import, or export your customers to CSV.
            </p>
          </div>
          <button
            disabled={currentDisabled}
            onClick={importCustomers}
            {...stylex.props(styles.actionLink)}
          >
            Import customers
            <ChevronRightIcon aria-hidden="true" {...stylex.props(styles.smallIcon)} />
          </button>
          <button
            disabled={currentDisabled}
            onClick={() => run('export')}
            {...stylex.props(styles.actionLink)}
          >
            Export all customers
            <ChevronRightIcon aria-hidden="true" {...stylex.props(styles.smallIcon)} />
          </button>
        </section>
      </div>
      <MigrationSnapshots application={application} />
    </main>
  );
}
