import { CaregiverList } from '@/components/access/CaregiverList';
import { MemberGroups } from '@/components/access/MemberGroups';

export default function ControlAccessPage() {
  return (
    <div className="flex flex-col justify-center p-8">
      <h1 className="mb-8 font-semibold text-sky-600">Control Access</h1>
      <MemberGroups />
      <CaregiverList />
    </div>
  );
}
