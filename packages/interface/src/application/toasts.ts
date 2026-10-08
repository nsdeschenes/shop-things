import {Toast} from '@base-ui/react/toast';
import type {ToastManager, ToastManagerAddOptions} from '@base-ui/react/toast';

type ToastOptions = Omit<ToastManagerAddOptions<object>, 'type'>;

const toastManager = Toast.createToastManager();

export function createToasts(manager: ToastManager = toastManager) {
  return {
    success: (options: ToastOptions) =>
      manager.add({priority: 'low', timeout: 5000, ...options, type: 'success'}),
    warning: (options: ToastOptions) =>
      manager.add({priority: 'high', timeout: 0, ...options, type: 'warning'}),
    error: (options: ToastOptions) =>
      manager.add({priority: 'high', timeout: 0, ...options, type: 'error'}),
    notice: (options: ToastOptions) =>
      manager.add({priority: 'low', timeout: 5000, ...options, type: 'notice'}),
  };
}

export const toasts = createToasts();

export default toastManager;
