import * as stylex from '@stylexjs/stylex';

import {colors} from '../../styles/colors.stylex';

const spin = stylex.keyframes({
  from: {transform: 'rotate(0deg)'},
  to: {transform: 'rotate(360deg)'},
});

const styles = stylex.create({
  spinner: {
    borderColor: colors.surface,
    borderRadius: '50%',
    borderStyle: 'solid',
    borderWidth: 4,
    animationDuration: '0.8s',
    animationIterationCount: 'infinite',
    animationName: {default: spin, '@media (prefers-reduced-motion: reduce)': 'none'},
    animationTimingFunction: 'linear',
    display: 'block',
    borderTopColor: colors.primary,
    height: 48,
    width: 48,
  },
  label: {
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    position: 'absolute',
    whiteSpace: 'nowrap',
    height: 1,
    width: 1,
  },
});

export default function LoadingSpinner({label = 'Loading…'}: {label?: string}) {
  return (
    <div role="status" aria-label={label}>
      <span aria-hidden="true" {...stylex.props(styles.spinner)} />
      <span {...stylex.props(styles.label)}>{label}</span>
    </div>
  );
}
