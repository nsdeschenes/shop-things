import {render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, test} from 'vitest';

import useAppForm from '../../forms/useAppForm';

function ProvinceForm({province = 'NS'}: {province?: string}) {
  const form = useAppForm({defaultValues: {province: province.toUpperCase()}});
  return (
    <>
      <form.AppField name="province">{field => <field.ProvinceField />}</form.AppField>
      <form.Subscribe selector={state => state.values.province}>
        {province => <output aria-label="Selected province">{province}</output>}
      </form.Subscribe>
    </>
  );
}

test('defaults to NS and allows filtering and selecting Canadian province codes', async () => {
  const user = userEvent.setup();
  render(<ProvinceForm />);
  const input = screen.getByRole('combobox', {name: 'Province'});
  expect(input).toHaveValue('NS');

  await user.click(screen.getByRole('button', {name: 'Province'}));
  expect(
    (await screen.findAllByRole('option')).map(option => option.textContent)
  ).toEqual(['NS', 'AB', 'BC', 'MB', 'NB', 'NL', 'ON', 'PE', 'QC', 'SK', 'Other']);

  await user.type(input, 'bc');
  expect(input).toHaveValue('bc');
  expect(screen.getAllByRole('option')).toHaveLength(1);
  await user.click(screen.getByRole('option', {name: 'BC'}));
  expect(input).toHaveValue('BC');
  expect(screen.getByLabelText('Selected province')).toHaveTextContent('BC');

  await user.type(input, 'on');
  await user.keyboard('{ArrowDown}{Enter}');
  expect(input).toHaveValue('ON');
  expect(screen.getByLabelText('Selected province')).toHaveTextContent('ON');

  await user.type(input, 'other');
  await user.click(screen.getByRole('option', {name: 'Other'}));
  expect(input).toHaveValue('Other');
  expect(screen.getByLabelText('Selected province')).toHaveTextContent('OTHER');
});

test('preserves an existing province and normalizes its code to uppercase', () => {
  render(<ProvinceForm province="bc" />);
  expect(screen.getByRole('combobox', {name: 'Province'})).toHaveValue('BC');
  expect(screen.getByLabelText('Selected province')).toHaveTextContent('BC');
});
