import {createFileRoute, redirect} from '@tanstack/react-router';

import DatabaseSettings from '../components/databaseSettings/databaseSettings';

export const Route = createFileRoute('/settings/database')({
  beforeLoad: ({context: {application}}) => {
    if (!application.getState().database?.available) {
      throw redirect({to: '/'});
    }
  },
  component: DatabaseSettingsRoute,
});

function DatabaseSettingsRoute() {
  const {application} = Route.useRouteContext();
  return <DatabaseSettings application={application} />;
}
