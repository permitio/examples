import Link from 'next/link';
import { SignOutButton } from '@/components/SignOutButton';
import { currentUser } from '@/lib/current-user';

export async function Header() {
  const user = await currentUser();
  return (
    <header className="flex h-[70px] items-center justify-between bg-gray-100 px-4">
      <Link href="/" className="flex flex-col items-center">
        <span className="text-xl text-slate-700">MESA VERDE</span>
        <span className="text-lg text-slate-600">Bank and Trust</span>
      </Link>
      {user === null ? null : (
        <div className="flex items-center gap-4">
          <span className="text-slate-700">{user.email}</span>
          <SignOutButton />
        </div>
      )}
    </header>
  );
}
