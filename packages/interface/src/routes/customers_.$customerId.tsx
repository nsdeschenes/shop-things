import { useForm } from "@tanstack/react-form";
import { createFileRoute } from "@tanstack/react-router";
import customerFormOptions from "../forms/customerFormOptions";

export const Route = createFileRoute("/customers_/$customerId")({
  component: RouteComponent,
  loader: () => {
    // react query to load customer data using customerId param
  },
});

function RouteComponent() {
  // load customer using react query
  const form = useForm(customerFormOptions(0));

  return (
    <div>
      Hello "/customers_/$rowid"!
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
