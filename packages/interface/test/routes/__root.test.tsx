import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import renderRoute from "../renderRoute";

test("disables opening a database in the preview", async () => {
  renderRoute("/customers");

  expect(await screen.findByRole("button", { name: "Open database" })).toBeDisabled();
});
