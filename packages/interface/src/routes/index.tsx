import { createFileRoute, redirect } from "@tanstack/react-router";
import * as stylex from "@stylexjs/stylex";

export const Route = createFileRoute("/")({
  component: Index,
  loader: () => {
    const loadedDB = true;
    if (loadedDB) {
      throw redirect({ to: "/customers" });
    }
  },
});

const styles = stylex.create({
  div: {
    padding: "4px",
  },
});

function Index() {
  return (
    <div {...stylex.props(styles.div)}>
      <h3>Welcome to Shop Things!</h3>
    </div>
  );
}
