import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// jsdom has no scrolling implementation; the router scrolls after navigation.
vi.spyOn(window, "scrollTo").mockImplementation(() => {});

afterEach(cleanup);
