import * as stylex from "@stylexjs/stylex";

export const breakpoints = stylex.defineConsts({
  compact: "@media (max-width: 600px)",
  form: "@media (max-width: 700px)",
  columns: "@media (max-width: 800px)",
});
