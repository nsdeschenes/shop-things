import {Toast} from '@base-ui/react/toast';
import {XCircleIcon} from '@heroicons/react/24/outline';
import * as stylex from '@stylexjs/stylex';

import {colors} from '../../styles/colors.stylex';
import {radii} from '../../styles/radii.stylex';
import {spacing} from '../../styles/spacing.stylex';
import {typography} from '../../styles/typography.stylex';

const styles = stylex.create({
  viewport: {
    gap: spacing.space12,
    alignItems: 'flex-end',
    display: 'flex',
    flexDirection: 'column',
    pointerEvents: 'none',
    position: 'fixed',
    zIndex: 200,
    bottom: spacing.space20,
    right: spacing.space20,
    width: 'min(320px, calc(100vw - 40px))',
  },
  toast: {
    borderRadius: radii.large,
    paddingBlock: spacing.space10,
    paddingInline: spacing.space12,
    backgroundColor: colors.noticeText,
    boxShadow: '0 6px 24px rgba(24, 63, 59, 0.18)',
    color: colors.onPrimary,
    display: {default: 'block', ':is([data-ending-style], [data-limited])': 'none'},
    pointerEvents: 'auto',
    maxWidth: '100%',
    width: 'fit-content',
  },
  success: {backgroundColor: colors.successText},
  error: {backgroundColor: colors.errorText},
  warning: {backgroundColor: colors.warningText},
  notice: {backgroundColor: colors.noticeText},
  content: {
    gap: spacing.space6,
    alignItems: 'center',
    display: 'grid',
    gridTemplateColumns: '28px minmax(0, 1fr) 28px',
  },
  message: {gridColumn: 2, textAlign: 'center', minWidth: 0},
  description: {
    fontSize: typography.fontSizeSmall,
    lineHeight: 1.3,
    overflowWrap: 'anywhere',
    marginTop: spacing.space4,
  },
  close: {
    padding: 0,
    borderRadius: radii.control,
    borderWidth: 0,
    gridColumn: 3,
    gridRow: 1,
    alignItems: 'center',
    backgroundColor: {default: 'transparent', ':hover': 'rgba(255, 255, 255, 0.16)'},
    color: colors.onPrimary,
    cursor: 'pointer',
    display: 'flex',
    fontSize: typography.fontSizeHeading,
    justifyContent: 'center',
    lineHeight: 1,
    outlineColor: colors.onPrimary,
    outlineOffset: 2,
    outlineStyle: {default: 'none', ':focus-visible': 'solid'},
    outlineWidth: 2,
    height: 28,
    width: 28,
  },
  closeIcon: {height: 24, width: 24},
  title: {
    fontSize: typography.fontSizeLarge,
    fontWeight: typography.fontWeightRegular,
    lineHeight: 1.25,
    overflowWrap: 'anywhere',
    minWidth: 0,
  },
});

export default function Toasts() {
  const {toasts} = Toast.useToastManager();

  return (
    <Toast.Portal>
      <Toast.Viewport {...stylex.props(styles.viewport)}>
        {toasts.map(toast => (
          <Toast.Root
            key={toast.id}
            toast={toast}
            {...stylex.props(
              styles.toast,
              toast.type === 'error' && styles.error,
              toast.type === 'success' && styles.success,
              toast.type === 'warning' && styles.warning,
              toast.type === 'notice' && styles.notice
            )}
          >
            <Toast.Content {...stylex.props(styles.content)}>
              <div {...stylex.props(styles.message)}>
                <Toast.Title {...stylex.props(styles.title)} />
                <Toast.Description {...stylex.props(styles.description)} />
              </div>
              <Toast.Close
                aria-label={
                  toast.type === 'error' ? 'Dismiss error' : 'Dismiss notification'
                }
                {...stylex.props(styles.close)}
              >
                <XCircleIcon aria-hidden="true" {...stylex.props(styles.closeIcon)} />
              </Toast.Close>
            </Toast.Content>
          </Toast.Root>
        ))}
      </Toast.Viewport>
    </Toast.Portal>
  );
}
