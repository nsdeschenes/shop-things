import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useDebouncedCallback } from "@tanstack/react-pacer";
import { z } from "zod";

export const Route = createFileRoute("/customers")({
  component: RouteComponent,
  validateSearch: z.object({
    search: z.string().optional().catch(undefined),
  }),
});

function RouteComponent() {
  const navigate = useNavigate({ from: Route.fullPath });
  const onSearch = useDebouncedCallback(
    (query: string) => {
      void navigate({ search: { search: query } });
    },
    { wait: 200 },
  );

  return (
    <div>
      <div>
        <input name="search" onChange={(e) => onSearch(e.currentTarget.value)} />
        <button>Clear Search</button>
      </div>
      <div>
        <ul>
          <li>List of customers</li>
        </ul>
      </div>
    </div>
  );
}
