import {createFileRoute} from '@tanstack/react-router';

import DatabaseSettings from '../components/databaseSettings/databaseSettings';

export const Route = createFileRoute('/settings')({component: SettingsRoute});

function SettingsRoute() {
  const {application} = Route.useRouteContext();
  return <DatabaseSettings application={application} />;
}
