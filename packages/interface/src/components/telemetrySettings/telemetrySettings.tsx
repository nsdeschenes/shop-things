import type {TelemetrySettingsState} from '@shop-things/contract';
import {telemetryDsnSchema} from '@shop-things/contract/schemas';
import * as stylex from '@stylexjs/stylex';
import {useEffect, useState, useSyncExternalStore} from 'react';

import type {Application} from '../../application/controller';
import {colors} from '../../styles/colors.stylex';
import Button from '../button/button';
import Input from '../input/input';

const styles = stylex.create({
  section: {
    padding: 24,
    borderColor: colors.border,
    borderRadius: 10,
    borderStyle: 'solid',
    borderWidth: 1,
    backgroundColor: colors.surface,
    marginBottom: 28,
  },
  title: {fontSize: 20, fontWeight: 600, marginBottom: 8},
  description: {color: colors.textMuted, fontSize: 14, lineHeight: 1.6, marginBottom: 16},
  field: {
    gap: 8,
    display: 'flex',
    flexDirection: 'column',
    marginBottom: 16,
    maxWidth: 640,
  },
  label: {fontSize: 14, fontWeight: 500},
  error: {color: colors.errorText, marginTop: 12},
  status: {fontSize: 14, marginTop: 12},
});

export default function TelemetrySettings({application}: {application: Application}) {
  const applicationState = useSyncExternalStore(
    application.subscribe,
    application.getState
  );
  const [settings, setSettings] = useState<TelemetrySettingsState | null>(null);
  const [dsn, setDsn] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const live = applicationState.mode === 'live';
  const loadError =
    error ??
    (!application.getClient()
      ? 'Could not load monitoring settings. Reopen Settings to try again.'
      : null);
  useEffect(() => {
    let active = true;
    const client = application.getClient();
    if (!client) {
      return;
    }

    void client.telemetry.status().then(result => {
      if (!active) {
        return;
      }

      if (result.status === 'success') {
        setSettings(result.value);
        setDsn(result.value.savedDsn ?? '');
      } else {
        setError('Could not load monitoring settings. Reopen Settings to try again.');
      }
    });
    return () => {
      active = false;
    };
  }, [application]);

  async function save() {
    setValidationError(null);
    const value = dsn.trim() || null;
    if (!telemetryDsnSchema.nullable().safeParse(value).success) {
      setValidationError(
        'Enter a valid HTTP or HTTPS Sentry DSN, or leave it blank to disable monitoring.'
      );
      return;
    }

    const client = application.getClient();
    if (!client) {
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const result = await client.telemetry.save({dsn: value});
      if (result.status === 'success') {
        setSettings(result.value);
        setDsn(result.value.savedDsn ?? '');
        setSaved(true);
      } else if (result.status === 'error') {
        setError('Could not save monitoring settings. Try again.');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-label="Monitoring" {...stylex.props(styles.section)}>
      <h2 {...stylex.props(styles.title)}>Monitoring</h2>
      <p {...stylex.props(styles.description)}>
        Send application errors, performance traces, logs, and metrics to your Sentry
        project. Customer records and file locations are excluded. Leave the DSN blank to
        disable monitoring after restarting.
      </p>
      {!live && (
        <p {...stylex.props(styles.description)}>
          Monitoring settings are available in the desktop app. Preview sends no
          monitoring data.
        </p>
      )}
      <form
        onSubmit={event => {
          event.preventDefault();
          void save();
        }}
      >
        <div {...stylex.props(styles.field)}>
          <label htmlFor="sentry-dsn" {...stylex.props(styles.label)}>
            Sentry DSN
          </label>
          <Input
            id="sentry-dsn"
            type="text"
            value={dsn}
            autoComplete="off"
            spellCheck={false}
            disabled={!live || !settings || saving}
            aria-describedby={
              validationError ? 'monitoring-state sentry-dsn-error' : 'monitoring-state'
            }
            aria-invalid={validationError ? true : undefined}
            onChange={event => {
              setDsn(event.target.value);
              setSaved(false);
              setError(null);
              setValidationError(null);
            }}
          />
          {validationError && (
            <p id="sentry-dsn-error" role="alert" {...stylex.props(styles.error)}>
              {validationError}
            </p>
          )}
        </div>
        <Button
          variant="primary"
          type="submit"
          disabled={
            !live || !settings || saving || (dsn.trim() || null) === settings.savedDsn
          }
        >
          {saving ? 'Saving monitoring' : 'Save monitoring'}
        </Button>
      </form>
      <p id="monitoring-state" role="status" {...stylex.props(styles.status)}>
        {settings === null
          ? 'Monitoring status is unknown for this session.'
          : settings.activeEnabled
            ? 'Monitoring is on for this session.'
            : 'Monitoring is off for this session.'}
        {settings?.restartRequired
          ? ' Restart Shop Things to apply the saved change.'
          : saved
            ? ' Monitoring settings saved.'
            : ''}
      </p>
      {loadError && (
        <p role="alert" {...stylex.props(styles.error)}>
          {loadError}
        </p>
      )}
    </section>
  );
}
