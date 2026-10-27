import * as stylex from '@stylexjs/stylex';

import {colors} from '../../styles/colors.stylex';
import LoadingSpinner from '../loadingSpinner/loadingSpinner';

const styles = stylex.create({
  nonblocking: {pointerEvents: 'none'},
  overlay: {
    inset: 0,
    placeItems: 'center',
    backgroundColor: colors.backdrop,
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
