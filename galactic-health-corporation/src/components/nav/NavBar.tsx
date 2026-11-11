'use client';

import CloseIcon from '@mui/icons-material/Close';
import MenuIcon from '@mui/icons-material/Menu';
import { Avatar, Drawer, IconButton, Menu, MenuItem } from '@mui/material';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type MouseEvent, useState } from 'react';
import { Brand } from '@/components/auth/Brand';
import { useUserContext } from '@/contexts/UserContext';
import { authClient } from '@/lib/auth-client';

const LINKS = [
  { href: '/plan', label: 'My Plan' },
  { href: '/invite', label: 'Delegate Permissions' },
  { href: '/access', label: 'Control Access' },
];

function UserMenu() {
  const router = useRouter();
  const { loggedInUser } = useUserContext();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const signOut = async () => {
    setAnchor(null);
    await authClient.signOut();
    router.replace('/sign-in');
    router.refresh();
  };

  return (
    <>
      <IconButton
        aria-label="Account menu"
        onClick={(event: MouseEvent<HTMLElement>) => setAnchor(event.currentTarget)}
      >
        <Avatar sx={{ bgcolor: '#0369a1' }}>{loggedInUser?.firstName.charAt(0) ?? '?'}</Avatar>
      </IconButton>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={() => setAnchor(null)}>
        <MenuItem disabled>
          {loggedInUser?.firstName} {loggedInUser?.lastName}
        </MenuItem>
        <MenuItem onClick={signOut}>Sign out</MenuItem>
      </Menu>
    </>
  );
}

export function NavBar() {
  const [open, setOpen] = useState(false);

  return (
    <nav className="w-full">
      <div className="flex items-center justify-between px-10">
        <Brand />
        <div className="flex items-center lg:hidden">
          <IconButton aria-label="Open menu" onClick={() => setOpen(true)}>
            <MenuIcon />
          </IconButton>
          <UserMenu />
        </div>
        <div className="hidden lg:flex lg:items-center">
          <div className="flex items-center text-sm font-semibold">
            {LINKS.map((link) => (
              <Link key={link.href} href={link.href} className="mr-8 text-black">
                {link.label}
              </Link>
            ))}
          </div>
          <UserMenu />
        </div>
      </div>
      <div className="h-3 w-full bg-sky-700" />
      <Drawer anchor="top" open={open} onClose={() => setOpen(false)}>
        <div className="relative flex flex-col items-center p-2 pt-16">
          <IconButton
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            sx={{ position: 'absolute', top: 8, right: 8 }}
          >
            <CloseIcon />
          </IconButton>
          <ul>
            {LINKS.map((link) => (
              <li key={link.href} className="mb-3 w-full text-center text-xl">
                <Link href={link.href} onClick={() => setOpen(false)}>
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </Drawer>
    </nav>
  );
}
