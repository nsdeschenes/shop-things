import * as stylex from '@stylexjs/stylex';

import {useAppearance, type AppearancePreference} from '../../application/appearance';
import {colors} from '../../styles/colors.stylex';
import {darkPalette, lightPalette} from '../../styles/palette.stylex';

const options: {value: AppearancePreference; label: string; description: string}[] = [
  {value: 'light', label: 'Light', description: 'A bright, clear workspace.'},
  {value: 'dark', label: 'Dark', description: 'A softer view in low light.'},
  {value: 'system', label: 'System', description: 'Follow your device settings.'},
];

const styles = stylex.create({
  panel: {
    padding: {default: 28, '@media (max-width: 600px)': 20},
    borderColor: colors.border,
    borderRadius: 12,
    borderStyle: 'solid',
    borderWidth: 1,
    backgroundColor: colors.surface,
    maxWidth: 880,
  },
  title: {fontSize: 20, fontWeight: 600, letterSpacing: -0.4, marginBottom: 8},
  description: {color: colors.textMuted, fontSize: 14, lineHeight: 1.6},
  fieldset: {padding: 0, borderWidth: 0, marginTop: 28, minWidth: 0},
  legend: {fontSize: 14, fontWeight: 600, marginBottom: 14},
  options: {
    gap: 16,
    display: 'grid',
    gridTemplateColumns: {
      default: 'repeat(3, minmax(0, 1fr))',
      '@media (max-width: 600px)': '1fr',
    },
  },
  option: {
    padding: 12,
    borderColor: {default: colors.border, ':hover': colors.controlBorder},
    borderRadius: 10,
    borderStyle: 'solid',
    borderWidth: 1,
    backgroundColor: {default: colors.surface, ':hover': colors.rowHover},
    cursor: 'pointer',
    minWidth: 0,
  },
  selected: {borderColor: colors.primary, boxShadow: `0 0 0 1px ${colors.primary}`},
  focus: {
    outlineColor: colors.focusRing,
    outlineOffset: 3,
    outlineStyle: {default: 'none', ':has(:focus-visible)': 'solid'},
    outlineWidth: 2,
  },
  preview: {
    borderColor: colors.border,
    borderRadius: 6,
    borderStyle: 'solid',
    borderWidth: 1,
    overflow: 'hidden',
    display: 'flex',
    height: {default: 104, '@media (max-width: 600px)': 72},
    marginBottom: 14,
  },
  previewPage: {
    display: 'flex',
    flexBasis: 0,
    flexDirection: 'column',
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  previewLight: {backgroundColor: lightPalette.pageBackground},
  previewDark: {backgroundColor: darkPalette.pageBackground},
  previewHeader: {backgroundColor: lightPalette.headerBackground, height: 16},
  previewBody: {padding: 10, gap: 6, display: 'flex', flexDirection: 'column'},
  previewLine: {borderRadius: 2, height: 4, width: '60%'},
  previewLightLine: {backgroundColor: lightPalette.textMuted},
  previewDarkLine: {backgroundColor: darkPalette.textMuted},
  previewRow: {borderRadius: 3, height: 14},
  previewLightRow: {backgroundColor: lightPalette.surface},
  previewDarkRow: {backgroundColor: darkPalette.surface},
  label: {gap: 8, alignItems: 'center', display: 'flex', fontSize: 14, fontWeight: 600},
  radio: {
    margin: 0,
    accentColor: colors.primary,
    cursor: 'pointer',
    height: 16,
    width: 16,
  },
  optionDescription: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 1.5,
    marginTop: 6,
  },
  hint: {color: colors.textMuted, fontSize: 13, marginTop: 20},
});

function Preview({preference}: {preference: AppearancePreference}) {
  const modes = preference === 'system' ? (['light', 'dark'] as const) : [preference];
  return (
    <div aria-hidden="true" {...stylex.props(styles.preview)}>
      {modes.map(mode => (
        <div
          key={mode}
          {...stylex.props(
            styles.previewPage,
            mode === 'light' ? styles.previewLight : styles.previewDark
          )}
        >
          <div {...stylex.props(styles.previewHeader)} />
          <div {...stylex.props(styles.previewBody)}>
            <div
              {...stylex.props(
                styles.previewLine,
                mode === 'light' ? styles.previewLightLine : styles.previewDarkLine
              )}
            />
            <div
              {...stylex.props(
                styles.previewRow,
                mode === 'light' ? styles.previewLightRow : styles.previewDarkRow
              )}
            />
            <div
              {...stylex.props(
                styles.previewRow,
                mode === 'light' ? styles.previewLightRow : styles.previewDarkRow
              )}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function AppearanceSettings() {
  const {preference, setPreference} = useAppearance();
  return (
    <section {...stylex.props(styles.panel)}>
      <h2 {...stylex.props(styles.title)}>Appearance</h2>
      <p {...stylex.props(styles.description)}>
        Choose how Shop Things looks on this device.
      </p>
      <fieldset {...stylex.props(styles.fieldset)}>
        <legend {...stylex.props(styles.legend)}>Color theme</legend>
        <div {...stylex.props(styles.options)}>
          {options.map(option => (
            <label
              key={option.value}
              {...stylex.props(
                styles.option,
                styles.focus,
                preference === option.value && styles.selected
              )}
            >
              <Preview preference={option.value} />
              <span {...stylex.props(styles.label)}>
                <input
                  type="radio"
                  name="appearance"
                  value={option.value}
                  checked={preference === option.value}
                  aria-labelledby={`appearance-${option.value}-label`}
                  aria-describedby={`appearance-${option.value}-description`}
                  onChange={() => setPreference(option.value)}
                  {...stylex.props(styles.radio)}
                />
                <span id={`appearance-${option.value}-label`}>{option.label}</span>
              </span>
              <p
                id={`appearance-${option.value}-description`}
                {...stylex.props(styles.optionDescription)}
              >
                {option.description}
              </p>
            </label>
          ))}
        </div>
      </fieldset>
      <p {...stylex.props(styles.hint)}>
        Changes apply immediately and are saved on this device.
      </p>
    </section>
  );
}
