import {createFileRoute, redirect} from '@tanstack/react-router';
import {useEffect, useSyncExternalStore} from 'react';

import PageShell from '../components/pageShell/pageShell';

export const Route = createFileRoute('/')({
  beforeLoad: ({context: {application}}) => {
    const state = application.getState();
    if (state.phase === 'ready' && state.database?.available && !state.recoveryRequired) {
      throw redirect({to: '/customers'});
    }
  },
  component: Index,
});

function Index() {
  const {application} = Route.useRouteContext();
  const state = useSyncExternalStore(application.subscribe, application.getState);
  const navigate = Route.useNavigate();
  useEffect(() => {
    if (state.phase === 'ready' && state.database?.available && !state.recoveryRequired) {
      void navigate({to: '/customers', replace: true});
    }
  }, [state, navigate]);
  return (
    <PageShell title="Shop Things">
      <p>Open or create a database to view customers.</p>
    </PageShell>
  );
}
