import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { routeTree } from "./routeTree.gen";

function renderRoute(path: string) {
  const queryClient = new QueryClient();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  return { router };
}

test("edits customer numbers locally while navigation uses the internal customer ID", async () => {
  const user = userEvent.setup();
  const { router } = renderRoute("/customers");

  const customerLink = await screen.findByRole("link", { name: "Test User" });
  expect(customerLink).toHaveAttribute("href", "/customers/1");
  expect(screen.getByRole("cell", { name: "1001" })).toBeInTheDocument();
  expect(screen.queryByText("Customer saved.")).not.toBeInTheDocument();
  await user.click(screen.getByRole("cell", { name: "1001" }));
  expect(await screen.findByRole("heading", { name: "Edit Customer" })).toBeInTheDocument();
  const customerNumber = screen.getByRole("textbox", { name: "Customer number" });
  expect(customerNumber).toHaveValue("1001");
  expect(customerNumber).toBeEnabled();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  await user.clear(customerNumber);
  await user.type(customerNumber, "2002");
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  await user.clear(customerNumber);
  await user.type(customerNumber, "1001");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  await user.clear(customerNumber);
  await user.type(customerNumber, "2002");
  expect(customerNumber).toHaveValue("2002");
  expect(router.state.location.pathname).toBe("/customers/1");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("heading", { name: "Customers" })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/customers");
  expect(screen.getByRole("cell", { name: "1001" })).toBeInTheDocument();
});

test("previews an empty list and handles new-customer fields without saving", async () => {
  const user = userEvent.setup();
  renderRoute("/customers?preview=empty");

  expect(await screen.findByRole("heading", { name: "No Customers Yet" })).toBeInTheDocument();
  expect(screen.getByText("0 customers")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open database" })).toBeDisabled();
  await user.type(screen.getByRole("textbox", { name: "Search customers" }), "Test");
  expect(screen.getByText("0 customers")).toBeInTheDocument();
  await user.click(screen.getByRole("link", { name: "Add customer" }));
  expect(await screen.findByRole("heading", { name: "New Customer" })).toBeInTheDocument();
  const customerNumber = screen.getByRole("textbox", { name: "Customer number" });
  expect(customerNumber).toHaveValue("");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  await user.type(customerNumber, "3003");
  await user.type(screen.getByRole("textbox", { name: "First name" }), "Alex");
  await user.type(screen.getByRole("textbox", { name: "Previous balance ($)" }), "-1");
  await user.click(screen.getByText("Donate", { exact: true }));
  await user.type(screen.getByRole("textbox", { name: "Comments" }), "Sample note");
  expect(customerNumber).toHaveValue("3003");
  expect(screen.getByRole("textbox", { name: "First name" })).toHaveValue("Alex");
  expect(screen.getByRole("checkbox", { name: "Donate" })).toBeChecked();
  expect(screen.getByRole("textbox", { name: "Comments" })).toHaveValue("Sample note");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("link", { name: "Test User" })).toBeInTheDocument();
  expect(screen.queryByText("Alex")).not.toBeInTheDocument();
});
