/* oxlint-disable import/no-named-export -- Shared customer route admission and request scope. */
import {redirect} from '@tanstack/react-router';

import type {Application, RequestScope} from './controller';

export async function waitForApplication(application: Application) {
  if (application.getState().phase !== 'loading') {
    return;
  }

  await new Promise<void>(resolve => {
    const stop = application.subscribe(() => {
      if (application.getState().phase !== 'loading') {
        stop();
        resolve();
      }
    });
  });
}

export function admitCustomerRoute({
  context: {application},
  cause,
  location,
}: {
  context: {application: Application};
  cause: 'preload' | 'enter' | 'stay';
  location: {state: object};
}) {
  const state = application.getState();
  // Staying on an admitted route retains its editor through database outages.
  if (
    cause !== 'stay' &&
    (state.phase !== 'ready' || !state.database?.available || state.recoveryRequired)
  ) {
    throw redirect({to: '/'});
  }

  const token: unknown = Reflect.get(location.state, 'customerNavigationRead');
  const scope: RequestScope = {
    navigationReadToken: typeof token === 'string' ? token : undefined,
  };
  const canRead =
    state.database?.available &&
    !state.recoveryRequired &&
    (!application.protection.getState().frozen ||
      application.protection.isNavigationReadCurrent(scope.navigationReadToken ?? ''));
  return {
    session: state.database?.session,
    readScope: canRead ? scope : undefined,
  };
}
