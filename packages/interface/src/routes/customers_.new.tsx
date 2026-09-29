import { useForm } from "@tanstack/react-form";
import { createFileRoute } from "@tanstack/react-router";
import customerFormOptions from "../forms/customerFormOptions";

export const Route = createFileRoute("/customers_/new")({
  component: RouteComponent,
});

function RouteComponent() {
  const form = useForm(customerFormOptions(0));
  return (
    <div>
      Hello "/customers_/id"!
      <div>
        <form
          onSubmit={(e) => {
            e.stopPropagation();
            e.preventDefault();
          }}
        >
          <form.Field name="firstName">
            {(field) => (
              <>
                <input
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </>
            )}
          </form.Field>
        </form>
      </div>
    </div>
  );
}
