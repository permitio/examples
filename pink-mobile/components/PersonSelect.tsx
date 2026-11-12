import { NativeSelect } from '@chakra-ui/react';
import { fullName, type Person } from '#lib/model';

interface PersonSelectProps {
  /** Shown as the empty choice, and read out by screen readers. */
  label: string;
  people: readonly Person[];
  value: string;
  onChange: (key: string) => void;
}

export function PersonSelect({ label, people, value, onChange }: PersonSelectProps) {
  return (
    <NativeSelect.Root size="sm">
      <NativeSelect.Field
        aria-label={label}
        placeholder={label}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {people.map((person) => (
          <option key={person.key} value={person.key}>
            {fullName(person)}
          </option>
        ))}
      </NativeSelect.Field>
      <NativeSelect.Indicator />
    </NativeSelect.Root>
  );
}
