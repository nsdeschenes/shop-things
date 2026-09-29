import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { routeTree } from "./routeTree.gen";

test("navigates from Home to About and back", async () => {
  const user = userEvent.setup();
  const queryClient = new QueryClient();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: { queryClient },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  expect(await screen.findByRole("heading", { name: "Welcome Home!" })).toBeInTheDocument();
  await user.click(screen.getByRole("link", { name: "About" }));
  expect(await screen.findByText("Hello from About!")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Welcome Home!" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("link", { name: "Home" }));
  expect(await screen.findByRole("heading", { name: "Welcome Home!" })).toBeInTheDocument();
});
