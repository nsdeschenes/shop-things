import * as stylex from '@stylexjs/stylex';

import LoadingSpinner from '../loadingSpinner/loadingSpinner';

const styles = stylex.create({
  nonblocking: {pointerEvents: 'none'},
  overlay: {
    inset: 0,
    placeItems: 'center',
    backgroundColor: 'rgba(100, 106, 104, 0.45)',
    display: 'grid',
    position: 'fixed',
    zIndex: 100,
  },
});

export default function LoadingOverlay({
  label,
  blocking = true,
}: {
  label: string;
  blocking?: boolean;
}) {
  return (
    <div {...stylex.props(styles.overlay, !blocking && styles.nonblocking)}>
      <LoadingSpinner label={label} />
    </div>
  );
}
