import * as stylex from '@stylexjs/stylex';
import {isCancelledError} from '@tanstack/react-query';
import {useRouter} from '@tanstack/react-router';
import {useEffect, useRef, useState, useSyncExternalStore} from 'react';

import type {Application} from '../../application/controller';
import {customerKeys, customerListOptions} from '../../application/customers';
import {spacing} from '../../styles/spacing.stylex';
import Button from '../button/button';
import Input from '../input/input';

type LookupState = {status: 'idle'} | {status: 'loading'};

const decimalDigits = /^\d+$/;
const styles = stylex.create({
  controls: {gap: spacing.space6, alignItems: 'center', display: 'flex'},
  input: {width: 160},
});

export default function CustomerLookup({application}: {application: Application}) {
  const state = useSyncExternalStore(application.subscribe, application.getState);
  const protection = useSyncExternalStore(
    application.protection.subscribe,
    application.protection.getState
  );
  const router = useRouter();
  const [customerNumber, setCustomerNumber] = useState('');
  const [lookup, setLookup] = useState<LookupState>({status: 'idle'});
  const mounted = useRef(false);
  const submitting = useRef(false);
  const disabled =
    state.phase !== 'ready' ||
    !state.database?.available ||
    Boolean(state.pendingFile) ||
    state.pendingTransition ||
    state.reconciling ||
    state.recoveryRequired ||
    state.refreshingCustomers ||
    protection.frozen ||
    protection.saving;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function openCustomer() {
    const session = state.database?.session;
    if (disabled || submitting.current || !session) {
      return;
    }

    const rawNumber = customerNumber.trim();
    const number = Number(rawNumber);
    if (!decimalDigits.test(rawNumber) || !Number.isSafeInteger(number) || number <= 0) {
      application.toasts.error({
        title: 'Could not open customer',
        description: 'Enter a positive whole customer number.',
      });
      return;
    }

    const captured = application.captureSession(session);
    function isRelevant() {
      return mounted.current && captured.isCurrent();
    }

    submitting.current = true;
    setLookup({status: 'loading'});
    try {
      const options = customerListOptions(application, session, String(number), {
        isRelevant,
        coalesceKey: 'customers:header-lookup',
      });
      const customers = await application.queryClient.fetchQuery({
        staleTime: 0,
        retry: options.retry,
        meta: options.meta,
        queryKey: [...customerKeys.session(session), 'lookup', String(number)],
        queryFn: context => options.queryFn!({...context, queryKey: options.queryKey}),
      });
      if (!isRelevant()) {
        return;
      }

      const record = customers.find(value => value.customer.customerNumber === number);
      if (!record) {
        application.toasts.error({
          title: 'Could not open customer',
          description: `Customer number ${number} was not found.`,
        });
        return;
      }

      void router
        .navigate({
          to: '/customers/$customerId',
          params: {customerId: String(record.customer.id)},
        })
        .catch(() => {
          if (isRelevant()) {
            application.toasts.error({
              title: 'Could not open customer',
              description: 'Could not open the customer. Try again.',
            });
          }
        });
    } catch (failure) {
      if (isRelevant() && !isCancelledError(failure)) {
        application.toasts.error({
          title: 'Could not open customer',
          description: 'Could not open the customer. Try again.',
        });
      }
    } finally {
      submitting.current = false;
      if (mounted.current) {
        setLookup({status: 'idle'});
      }
    }
  }

  return (
    <form
      {...stylex.props(styles.controls)}
      onSubmit={event => {
        event.preventDefault();
        void openCustomer();
      }}
    >
      <div {...stylex.props(styles.input)}>
        <Input
          aria-label="Go to customer number"
          placeholder="Customer number"
          inputMode="numeric"
          value={customerNumber}
          disabled={disabled || lookup.status === 'loading'}
          onValueChange={setCustomerNumber}
        />
      </div>
      <Button type="submit" disabled={disabled} busy={lookup.status === 'loading'}>
        Go
      </Button>
    </form>
  );
}
