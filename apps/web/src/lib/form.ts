/** A form field's value, or "" when missing or not a string (e.g. a File). */
export function stringField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}
