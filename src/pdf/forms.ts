import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
} from 'pdf-lib';

export type FieldInfo =
  | { name: string; type: 'text'; value: string; multiline: boolean }
  | { name: string; type: 'checkbox'; value: boolean }
  | { name: string; type: 'dropdown' | 'radio' | 'list'; value: string; options: string[] };

export async function readFields(bytes: Uint8Array): Promise<FieldInfo[]> {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = pdf.getForm();
  const out: FieldInfo[] = [];
  for (const f of form.getFields()) {
    const name = f.getName();
    try {
      if (f instanceof PDFTextField)
        out.push({ name, type: 'text', value: f.getText() ?? '', multiline: f.isMultiline() });
      else if (f instanceof PDFCheckBox) out.push({ name, type: 'checkbox', value: f.isChecked() });
      else if (f instanceof PDFDropdown)
        out.push({ name, type: 'dropdown', value: f.getSelected()[0] ?? '', options: f.getOptions() });
      else if (f instanceof PDFOptionList)
        out.push({ name, type: 'list', value: f.getSelected()[0] ?? '', options: f.getOptions() });
      else if (f instanceof PDFRadioGroup)
        out.push({ name, type: 'radio', value: f.getSelected() ?? '', options: f.getOptions() });
    } catch {
      /* champ non pris en charge */
    }
  }
  return out;
}

export async function writeFields(
  bytes: Uint8Array,
  values: Record<string, string | boolean>,
  flatten: boolean,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = pdf.getForm();
  for (const [name, v] of Object.entries(values)) {
    const f = form.getFieldMaybe(name);
    if (!f) continue;
    try {
      if (f instanceof PDFTextField) f.setText(String(v));
      else if (f instanceof PDFCheckBox) (v ? f.check() : f.uncheck());
      else if (f instanceof PDFDropdown || f instanceof PDFOptionList) v && f.select(String(v));
      else if (f instanceof PDFRadioGroup) v && f.select(String(v));
    } catch {
      /* valeur invalide ignorée */
    }
  }
  if (flatten) form.flatten();
  return pdf.save();
}
