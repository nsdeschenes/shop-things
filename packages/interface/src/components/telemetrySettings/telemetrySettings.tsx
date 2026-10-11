import type {TelemetrySampling, TelemetrySettingsState} from '@shop-things/contract';
import {
  defaultTelemetrySampling,
  telemetryDsnSchemaForEnvironment,
  telemetrySamplingSchema,
} from '@shop-things/contract/schemas';
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
  hint: {color: colors.textMuted, fontSize: 14, lineHeight: 1.6},
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

const samplingFields = [
  {
    key: 'errors',
    label: 'Error sampling (%)',
    description: 'Percentage of errors to send.',
  },
  {
    key: 'traces',
    label: 'Trace sampling (%)',
    description: 'Percentage of performance traces to send.',
  },
  {
    key: 'logs',
    label: 'Log sampling (%)',
    description: 'Percentage of log entries to send.',
  },
  {
    key: 'metrics',
    label: 'Metric sampling (%)',
    description: 'Percentage of metric measurements to send. Counts are not scaled up.',
  },
] as const;

export default function TelemetrySettings({application}: {application: Application}) {
  const applicationState = useSyncExternalStore(
    application.subscribe,
    application.getState
  );
  const [settings, setSettings] = useState<TelemetrySettingsState | null>(null);
  const [dsn, setDsn] = useState('');
  const [sampling, setSampling] = useState({
    errors: String(defaultTelemetrySampling.errors),
    traces: String(defaultTelemetrySampling.traces),
    logs: String(defaultTelemetrySampling.logs),
    metrics: String(defaultTelemetrySampling.metrics),
  });
  const [samplingErrors, setSamplingErrors] = useState<
    Partial<Record<keyof TelemetrySampling, string>>
  >({});
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
        setSampling({
          errors: String(result.value.savedSampling.errors),
          traces: String(result.value.savedSampling.traces),
          logs: String(result.value.savedSampling.logs),
          metrics: String(result.value.savedSampling.metrics),
        });
      } else {
        setError('Could not load monitoring settings. Reopen Settings to try again.');
      }
    });
    return () => {
      active = false;
    };
  }, [application]);

  async function save() {
    if (!settings) {
      return;
    }

    setValidationError(null);
    setSamplingErrors({});
    const value = dsn.trim() || null;
    const parsedDsn = telemetryDsnSchemaForEnvironment(settings.environment)
      .nullable()
      .safeParse(value);
    if (!parsedDsn.success) {
      setValidationError(
        `${parsedDsn.error.issues[0]?.message} Leave it blank to disable monitoring.`
      );
      return;
    }

    const percentages = {
      errors: Number(sampling.errors),
      traces: Number(sampling.traces),
      logs: Number(sampling.logs),
      metrics: Number(sampling.metrics),
    };
    const fieldErrors: Partial<Record<keyof TelemetrySampling, string>> = {};
    for (const field of samplingFields) {
      if (
        !sampling[field.key].trim() ||
        !telemetrySamplingSchema.shape[field.key].safeParse(percentages[field.key])
          .success
      ) {
        fieldErrors[field.key] = 'Enter a percentage from 0 to 100.';
      }
    }

    if (Object.keys(fieldErrors).length > 0) {
      setSamplingErrors(fieldErrors);
      return;
    }

    const client = application.getClient();
    if (!client) {
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const result = await client.telemetry.save({dsn: value, sampling: percentages});
      if (result.status === 'success') {
        setSettings(result.value);
        setDsn(result.value.savedDsn ?? '');
        setSampling({
          errors: String(result.value.savedSampling.errors),
          traces: String(result.value.savedSampling.traces),
          logs: String(result.value.savedSampling.logs),
          metrics: String(result.value.savedSampling.metrics),
        });
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
        project. Customer number, stock, balances, and donation flag supplied when
        creating or updating a customer may be reported. Personal fields and file
        locations are excluded. Leave the DSN blank to disable monitoring after
        restarting.
      </p>
      <p {...stylex.props(styles.description)}>
        Production requires HTTPS for remote destinations. HTTP is allowed only for
        localhost, 127.0.0.1, or [::1]. Development also allows remote HTTP.
      </p>
      {!live && (
        <p {...stylex.props(styles.description)}>
          Monitoring settings are available in the desktop app. Preview sends no
          monitoring data.
        </p>
      )}
      <form
        noValidate
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
        <p {...stylex.props(styles.description)}>
          Sampling applies across the app after restarting. Use 0% to send none or 100% to
          send all.
        </p>
        {samplingFields.map(field => (
          <div key={field.key} {...stylex.props(styles.field)}>
            <label
              htmlFor={`sentry-sampling-${field.key}`}
              {...stylex.props(styles.label)}
            >
              {field.label}
            </label>
            <Input
              id={`sentry-sampling-${field.key}`}
              type="number"
              min={0}
              max={100}
              step="any"
              value={sampling[field.key]}
              disabled={!live || !settings || saving}
              aria-describedby={`sentry-sampling-${field.key}-help${samplingErrors[field.key] ? ` sentry-sampling-${field.key}-error` : ''}`}
              aria-invalid={samplingErrors[field.key] ? true : undefined}
              onChange={event => {
                setSampling({...sampling, [field.key]: event.target.value});
                setSamplingErrors({...samplingErrors, [field.key]: undefined});
                setSaved(false);
                setError(null);
              }}
            />
            <p id={`sentry-sampling-${field.key}-help`} {...stylex.props(styles.hint)}>
              {field.description}
            </p>
            {samplingErrors[field.key] && (
              <p
                id={`sentry-sampling-${field.key}-error`}
                role="alert"
                {...stylex.props(styles.error)}
              >
                {samplingErrors[field.key]}
              </p>
            )}
          </div>
        ))}
        <Button
          variant="primary"
          type="submit"
          disabled={
            !live ||
            !settings ||
            saving ||
            ((dsn.trim() || null) === settings.savedDsn &&
              samplingFields.every(
                field => sampling[field.key] === String(settings.savedSampling[field.key])
              ))
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
