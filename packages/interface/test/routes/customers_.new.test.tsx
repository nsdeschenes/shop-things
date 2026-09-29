import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import renderRoute from "../renderRoute";

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
  await user.type(screen.getByRole("textbox", { name: "Customer number" }), "3003");
  await user.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByRole("link", { name: "Test User" })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/customers");
  expect(screen.queryByText("Alex")).not.toBeInTheDocument();
});
