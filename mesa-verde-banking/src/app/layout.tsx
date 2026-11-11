import '@/app/globals.css';

import { AntdRegistry } from '@ant-design/nextjs-registry';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Header } from '@/components/Header';

export const metadata: Metadata = {
  title: 'Mesa Verde Bank',
  description: 'A banking app that shows fine-grained access control with Permit.io.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AntdRegistry>
          <Header />
          <main>
            <div className="container">{children}</div>
          </main>
        </AntdRegistry>
      </body>
    </html>
  );
}
