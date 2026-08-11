export function integerFormValue(
  form: FormData,
  name: string,
): number | undefined {
  const value = String(form.get(name) ?? "").trim();
  return value === "" ? undefined : Number(value);
}
