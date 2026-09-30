import {render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, test} from 'vitest';
import {z} from 'zod';

import useAppForm from '../../forms/useAppForm';

const initialNumberPattern = /^1001$/;
const editedNumberPattern = /^2002$/;

function CustomerNumberForm() {
  const form = useAppForm({
    defaultValues: {customerNumber: 1001 as number | null},
    validators: {
      onChange: z.object({customerNumber: z.number({error: 'Enter a customer number.'})}),
    },
  });
  return (
    <>
      <form.AppField name="customerNumber">
        {field => <field.NumberField label="Customer number" />}
      </form.AppField>
      <form.Subscribe selector={state => state.values.customerNumber}>
        {value => <output aria-label="Numeric value">{JSON.stringify(value)}</output>}
      </form.Subscribe>
    </>
  );
}

test('stores customer numbers as numbers, rejects letters, and validates an empty value', async () => {
  const user = userEvent.setup();
  render(<CustomerNumberForm />);
  const input = screen.getByRole('textbox', {name: 'Customer number'});
  expect(screen.getByLabelText('Numeric value')).toHaveTextContent(initialNumberPattern);

  await user.clear(input);
  expect(input).toBeInvalid();
  expect(input).toHaveAccessibleDescription('Enter a customer number.');

  await user.type(input, '2002abc');
  expect(input).toHaveValue('2002');
  expect(screen.getByLabelText('Numeric value')).toHaveTextContent(editedNumberPattern);
  expect(input).not.toBeInvalid();
});
