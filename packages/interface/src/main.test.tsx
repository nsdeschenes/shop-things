import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import renderRoute from "../test/renderRoute";

test("opens a customer row using the internal customer ID", async () => {
  const user = userEvent.setup();
  const { router } = renderRoute("/customers");

  const customerLink = await screen.findByRole("link", { name: "Test User" });
  expect(customerLink).toHaveAttribute("href", "/customers/1");
  expect(screen.queryByText("Customer saved.")).not.toBeInTheDocument();

  await user.click(screen.getByRole("cell", { name: "1001" }));
  expect(await screen.findByRole("heading", { name: "Edit Customer" })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/customers/1");
});

test("edits the customer number without changing the customer route", async () => {
  const user = userEvent.setup();
  const { router } = renderRoute("/customers/1");

  const customerNumber = await screen.findByRole("textbox", { name: "Customer number" });
  expect(customerNumber).toHaveValue("1001");
  expect(customerNumber).toBeEnabled();

  await user.clear(customerNumber);
  await user.type(customerNumber, "2002");
  expect(customerNumber).toHaveValue("2002");
  expect(router.state.location.pathname).toBe("/customers/1");
});

test("enables Save only while customer values differ from their defaults", async () => {
  const user = userEvent.setup();
  renderRoute("/customers/1");

  const customerNumber = await screen.findByRole("textbox", { name: "Customer number" });
  const saveButton = screen.getByRole("button", { name: "Save" });
  expect(saveButton).toBeDisabled();

  await user.clear(customerNumber);
  await user.type(customerNumber, "2002");
  expect(saveButton).toBeEnabled();

  await user.clear(customerNumber);
  await user.type(customerNumber, "1001");
  expect(saveButton).toBeDisabled();
});

test("returns to the list after Save without persisting edits to an existing customer", async () => {
  const user = userEvent.setup();
  const { router } = renderRoute("/customers/1");

  const customerNumber = await screen.findByRole("textbox", { name: "Customer number" });
  await user.clear(customerNumber);
  await user.type(customerNumber, "2002");
  await user.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByRole("heading", { name: "Customers" })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/customers");
  expect(screen.getByRole("cell", { name: "1001" })).toBeInTheDocument();
  expect(screen.queryByRole("cell", { name: "2002" })).not.toBeInTheDocument();
});

test("keeps the empty customer preview empty when entering a search", async () => {
  const user = userEvent.setup();
  renderRoute("/customers?preview=empty");

  expect(await screen.findByRole("heading", { name: "No Customers Yet" })).toBeInTheDocument();
  expect(screen.getByText("0 customers")).toBeInTheDocument();

  await user.type(screen.getByRole("textbox", { name: "Search customers" }), "Test");
  expect(screen.getByText("0 customers")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Test User" })).not.toBeInTheDocument();
});

test("disables opening a database in the preview", async () => {
  renderRoute("/customers");

  expect(await screen.findByRole("button", { name: "Open database" })).toBeDisabled();
});

test("opens a blank customer form with Save disabled from Add customer", async () => {
  const user = userEvent.setup();
  renderRoute("/customers?preview=empty");

  await user.click(await screen.findByRole("link", { name: "Add customer" }));
  expect(await screen.findByRole("heading", { name: "New Customer" })).toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Customer number" })).toHaveValue("");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
});

test("accepts text, negative balances, donation preference, and comments in a new customer form", async () => {
  const user = userEvent.setup();
  renderRoute("/customers/new");

  const customerNumber = await screen.findByRole("textbox", { name: "Customer number" });
  await user.type(customerNumber, "3003");
  await user.type(screen.getByRole("textbox", { name: "First name" }), "Alex");
  const previousBalance = screen.getByRole("textbox", { name: "Previous balance ($)" });
  await user.clear(previousBalance);
  await user.type(previousBalance, "-1");
  await user.click(screen.getByText("Donate", { exact: true }));
  await user.type(screen.getByRole("textbox", { name: "Comments" }), "Sample note");

  expect(customerNumber).toHaveValue("3003");
  expect(screen.getByRole("textbox", { name: "First name" })).toHaveValue("Alex");
  expect(previousBalance).toHaveValue("-1");
  expect(screen.getByRole("checkbox", { name: "Donate" })).toBeChecked();
  expect(screen.getByRole("textbox", { name: "Comments" })).toHaveValue("Sample note");
});

test("returns to the list after Save without adding the preview customer", async () => {
  const user = userEvent.setup();
  const { router } = renderRoute("/customers/new");

  const firstName = await screen.findByRole("textbox", { name: "First name" });
  await user.type(firstName, "Alex");
  await user.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByRole("link", { name: "Test User" })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/customers");
  expect(screen.queryByText("Alex")).not.toBeInTheDocument();
});
