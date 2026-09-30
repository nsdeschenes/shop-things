import {createFormHook} from '@tanstack/react-form';

import CheckboxField from '../components/formFields/checkboxField';
import NumberField from '../components/formFields/numberField';
import ProvinceField from '../components/formFields/provinceField';
import TextareaField from '../components/formFields/textareaField';
import TextField from '../components/formFields/textField';
import formContexts from './formContexts';

const {useAppForm} = createFormHook({
  fieldContext: formContexts.fieldContext,
  formContext: formContexts.formContext,
  fieldComponents: {TextField, NumberField, ProvinceField, CheckboxField, TextareaField},
  formComponents: {},
});

export default useAppForm;
