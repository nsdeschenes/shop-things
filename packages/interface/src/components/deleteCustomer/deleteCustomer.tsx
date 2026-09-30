import {Dialog} from '@base-ui/react/dialog';
import type {CustomerRecord} from '@shop-things/contract';
import * as stylex from '@stylexjs/stylex';
import {isCancelledError, useMutation} from '@tanstack/react-query';
import {useEffect, useRef, useState} from 'react';

import type {Application} from '../../application/controller';
import {
  CustomerRequestError,
  customerKeys,
  deleteCustomerOptions,
} from '../../application/customers';
import {colors} from '../../styles/colors.stylex';
import {radii} from '../../styles/radii.stylex';
import {spacing} from '../../styles/spacing.stylex';
import Button from '../button/button';

const styles = stylex.create({
  dialog: {
    padding: spacing.space24,
    borderRadius: radii.panel,
    backgroundColor: colors.surface,
    color: colors.text,
    position: 'fixed',
    transform: 'translate(-50%, -50%)',
    left: '50%',
    top: '50%',
    width: 'min(440px, 90vw)',
  },
  actions: {gap: spacing.space12, display: 'flex', marginTop: spacing.space20},
});

interface Props {
  application: Application;
  record: CustomerRecord;
  disabled: boolean;
  onDeleted(this: void): void;
}

export default function DeleteCustomer({
  application,
  record,
  disabled,
  onDeleted,
}: Props) {
  const [selected, setSelected] = useState<CustomerRecord | null>(null);
  const mounted = useRef(false);
  const mutation = useMutation(deleteCustomerOptions(application));
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const error =
    mutation.error instanceof CustomerRequestError ? mutation.error.error : null;
  const blocked =
    error !== null &&
    [
      'STALE_REVISION',
      'CUSTOMER_DELETED',
      'STALE_SESSION',
      'DATABASE_UNAVAILABLE',
    ].includes(error.code);
  async function confirmDelete() {
    if (!selected || disabled || mutation.isPending || blocked) {
      return;
    }

    const reference = selected.reference;
    const scope = application.captureSession(reference.session);
    setSelected(null);
    try {
      await mutation.mutateAsync(reference);
      if (!scope.isCurrent()) {
        return;
      }

      application.queryClient.removeQueries({
        queryKey: customerKeys.detail(reference.session, reference.id),
      });
      const lists = ['customers', reference.session, 'list'];
      // Inactive reads disable mount refetches; active lists need a fresh read even
      // when the user left the detail before this response settled.
      application.queryClient.removeQueries({queryKey: lists, type: 'inactive'});
      await application.queryClient.invalidateQueries({
        queryKey: lists,
        refetchType: 'active',
      });
      if (!scope.isCurrent()) {
        return;
      }

      application.queryClient.removeQueries({queryKey: lists, type: 'inactive'});
      if (!mounted.current) {
        return;
      }

      onDeleted();
    } catch {
      // TanStack owns failure feedback. Obsolete completions never navigate or update caches.
    }
  }

  return (
    <>
      <Button
        disabled={disabled || mutation.isPending || blocked}
        onClick={() => setSelected(record)}
      >
        {mutation.isPending ? 'Deleting customer…' : 'Delete customer'}
      </Button>
      {mutation.isError && !isCancelledError(mutation.error) && (
        <p role="alert">{mutation.error.message}</p>
      )}
      <Dialog.Root
        open={selected !== null}
        onOpenChange={open => {
          if (!open) {
            setSelected(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Popup
            initialFocus={() => document.getElementById('delete-cancel')}
            {...stylex.props(styles.dialog)}
          >
            <Dialog.Title>Delete Customer?</Dialog.Title>
            <Dialog.Description>
              Delete {selected?.customer.firstName} {selected?.customer.lastName}{' '}
              (customer number {selected?.customer.customerNumber ?? 'Unassigned'})? This
              cannot be undone.
            </Dialog.Description>
            <div {...stylex.props(styles.actions)}>
              <Button id="delete-cancel" onClick={() => setSelected(null)}>
                Cancel
              </Button>
              <Button
                disabled={disabled || mutation.isPending || blocked}
                onClick={() => {
                  void confirmDelete();
                }}
              >
                Delete customer
              </Button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
