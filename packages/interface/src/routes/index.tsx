import { createFileRoute } from "@tanstack/react-router";
import * as stylex from "@stylexjs/stylex";

export const Route = createFileRoute("/")({
  component: Index,
});

const styles = stylex.create({
  div: {
    padding: "4px",
  },
});

function Index() {
  return (
    <div {...stylex.props(styles.div)}>
      <h3>Welcome Home!</h3>
    </div>
  );
}
