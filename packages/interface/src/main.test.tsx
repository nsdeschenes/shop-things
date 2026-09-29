import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { routeTree } from "./routeTree.gen";

test("navigates from customer details to the customer list through Home", async () => {
  const user = userEvent.setup();
  const queryClient = new QueryClient();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/customers/1"] }),
    context: { queryClient },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  expect(await screen.findByText('Hello "/customers_/$rowid"!')).toBeInTheDocument();
  await user.click(screen.getByRole("link", { name: "Home" }));
  expect(await screen.findByText("List of customers")).toBeInTheDocument();
  expect(screen.queryByText('Hello "/customers_/$rowid"!')).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Customers" })).toHaveAttribute("aria-current", "page");
});
