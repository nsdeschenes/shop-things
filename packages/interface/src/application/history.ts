import {createBrowserHistory} from '@tanstack/react-router';

// Bootstrap switches stay outside the hash; only hash parameters belong to routes.
export default function createApplicationHistory() {
  return createBrowserHistory({
    parseLocation: () => {
      const href = window.location.hash.slice(1) || '/';
      const route = new URL(href, 'http://shop-things.invalid');
      return {
        href,
        pathname: route.pathname,
        search: route.search,
        hash: route.hash,
        state: window.history.state ?? {__TSR_index: 0},
      };
    },
    createHref: href => `${window.location.pathname}${window.location.search}#${href}`,
  });
}
