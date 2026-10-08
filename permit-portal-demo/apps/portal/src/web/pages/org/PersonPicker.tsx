// A person picker: the UI kit's select, as in the approver's "Access lasts" menu, listing names and
// answering with the user key.

import { Field, FieldLabel } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

interface PersonPickerProps {
  id: string;
  label: string;
  /** The chosen user key; always one of `options`. */
  value: string;
  options: readonly string[];
  nameOf: (key: string) => string;
  onChange: (key: string) => void;
  className?: string;
}

/** One of `options` (user keys), each shown by its persona's name. */
export function PersonPicker({ id, label, value, options, nameOf, onChange, className }: PersonPickerProps) {
  const items = options.map((key) => ({ value: key, label: nameOf(key) }));
  return (
    <Field className={cn('max-w-md', className)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select
        items={items}
        value={value}
        onValueChange={(next) => {
          if (next !== null && next !== undefined) onChange(next);
        }}
      >
        <SelectTrigger id={id} className="h-9 w-full text-base">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value} className="text-base">
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
