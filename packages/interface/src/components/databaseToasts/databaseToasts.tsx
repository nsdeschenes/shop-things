import {Toast} from '@base-ui/react/toast';
import * as stylex from '@stylexjs/stylex';
import {useEffect, useSyncExternalStore} from 'react';

import type {Application} from '../../application/controller';
import {colors} from '../../styles/colors.stylex';
import {controls} from '../../styles/controls.stylex';
import {radii} from '../../styles/radii.stylex';
import {spacing} from '../../styles/spacing.stylex';
import {typography} from '../../styles/typography.stylex';
import Button from '../button/button';

const styles = stylex.create({
  viewport: {
    gap: spacing.space12,
    display: 'flex',
    flexDirection: 'column',
    pointerEvents: 'none',
    position: 'fixed',
    zIndex: 200,
    bottom: spacing.space20,
    right: spacing.space20,
    width: 'min(420px, calc(100vw - 40px))',
  },
  toast: {
    padding: spacing.space16,
    borderColor: colors.border,
    borderRadius: radii.large,
    borderStyle: 'solid',
    borderWidth: controls.borderWidth,
    backgroundColor: colors.surface,
    borderInlineStartWidth: 4,
    boxShadow: '0 6px 24px rgba(24, 63, 59, 0.18)',
    color: colors.text,
    display: {default: 'block', ':is([data-ending-style], [data-limited])': 'none'},
    pointerEvents: 'auto',
  },
  success: {borderInlineStartColor: colors.successText},
  error: {borderInlineStartColor: colors.errorText},
  content: {gap: spacing.space12, alignItems: 'flex-start', display: 'flex'},
  title: {
    flexGrow: 1,
    fontSize: typography.fontSizeBody,
    fontWeight: typography.fontWeightMedium,
    lineHeight: 1.5,
    overflowWrap: 'anywhere',
    minWidth: 0,
  },
});

function DatabaseToastMessages({application}: {application: Application}) {
  const {fileError, fileSuccess, pendingFile} = useSyncExternalStore(
    application.subscribe,
    application.getState
  );
  const {toasts, add, close} = Toast.useToastManager();

  useEffect(() => {
    if (pendingFile) {
      close('database-feedback');
      return;
    }

    if (fileError) {
      add({
        id: 'database-feedback',
        title: fileError,
        type: 'error',
        priority: 'high',
        timeout: 0,
        onClose: () => {
          if (application.getState().fileError === fileError) {
            application.dismissFileError();
          }
        },
      });
    } else if (fileSuccess) {
      add({
        id: 'database-feedback',
        title: fileSuccess,
        type: 'success',
        priority: 'low',
        timeout: 5000,
        onClose: undefined,
      });
    }
  }, [add, close, application, fileError, fileSuccess, pendingFile]);

  return (
    <Toast.Portal>
      <Toast.Viewport {...stylex.props(styles.viewport)}>
        {toasts.map(toast => (
          <Toast.Root
            key={toast.id}
            toast={toast}
            {...stylex.props(
              styles.toast,
              toast.type === 'error' ? styles.error : styles.success
            )}
          >
            <Toast.Content {...stylex.props(styles.content)}>
              <Toast.Title {...stylex.props(styles.title)} />
              <Toast.Close
                aria-label={
                  toast.type === 'error' ? 'Dismiss error' : 'Dismiss notification'
                }
                render={<Button />}
              >
                <span aria-hidden="true">×</span>
              </Toast.Close>
            </Toast.Content>
          </Toast.Root>
        ))}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

export default function DatabaseToasts({application}: {application: Application}) {
  return (
    <Toast.Provider>
      <DatabaseToastMessages application={application} />
    </Toast.Provider>
  );
}
