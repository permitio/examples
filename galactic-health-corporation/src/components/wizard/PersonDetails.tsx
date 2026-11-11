import type { Person } from '@/lib/resources';

/** A person's details as the wizard lists them. */
export function PersonDetails({ person }: { person: Person }) {
  const rows = [
    ['First name', person.firstName],
    ['Last name', person.lastName],
    ['Date of Birth', person.dateOfBirth],
    ['Relationship', person.relationship],
    ['Phone number', person.phoneNumber],
    ['Email address', person.email],
  ];
  return (
    <div className="ml-6">
      {rows.map(([label, value]) => (
        <div key={label} className="mb-3 flex flex-col">
          <span className="font-bold">{label}:</span> {value}
        </div>
      ))}
    </div>
  );
}
