import { createFormHook } from "@tanstack/react-form";
import TextField from "../components/formFields/textField";
import ProvinceField from "../components/formFields/provinceField";
import CheckboxField from "../components/formFields/checkboxField";
import TextareaField from "../components/formFields/textareaField";
import formContexts from "./formContexts";

const { useAppForm } = createFormHook({
  fieldContext: formContexts.fieldContext,
  formContext: formContexts.formContext,
  fieldComponents: { TextField, ProvinceField, CheckboxField, TextareaField },
  formComponents: {},
});

export default useAppForm;
