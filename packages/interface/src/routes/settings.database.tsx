import {createFileRoute, redirect} from '@tanstack/react-router';

export const Route = createFileRoute('/settings/database')({
  beforeLoad: () => {
    throw redirect({to: '/settings'});
  },
});
