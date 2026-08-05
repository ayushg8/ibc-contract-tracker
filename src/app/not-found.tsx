'use client';

import { useRouter } from 'next/navigation';
import { Compass } from '@phosphor-icons/react';

import { Button, Card, EmptyState } from '@/components/ui';

export default function NotFound() {
  const router = useRouter();

  return (
    <div className="grid h-full w-full place-items-center bg-canvas p-[24px]">
      <Card padding="lg" elevated className="w-full max-w-[420px]">
        <EmptyState
          icon={Compass}
          title="There is nothing here."
          body="That link points at a screen the tracker does not have, or a record that has since been removed."
          action={
            <Button variant="primary" onClick={() => router.push('/inbox')}>
              Go to the Inbox
            </Button>
          }
        />
      </Card>
    </div>
  );
}
