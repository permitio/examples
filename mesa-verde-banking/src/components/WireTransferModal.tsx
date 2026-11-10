'use client';

import { Alert, Button, Form, Input, InputNumber, Modal, Select, Skeleton } from 'antd';
import { useEffect, useState, useTransition } from 'react';
import { useAccount } from '@/components/AccountContext';
import { PermitElement } from '@/components/PermitElement';
import { useTransactions } from '@/components/TransactionsContext';
import type { Recipient, TransferRefusal } from '@/lib/api-types';
import { ELEMENTS } from '@/lib/elements';

interface TransferValues {
  to: string;
  description: string;
  amount: number;
  otp?: string;
}

type Outcome =
  | { status: 'editing'; needsCode: boolean; notice?: string }
  | { status: 'sent' }
  | { status: 'approval'; transfer: string }
  | { status: 'denied' }
  | { status: 'failed' };

async function sendTransfer(tenant: string, values: TransferValues): Promise<Outcome> {
  const response = await fetch(`/account/api/transactions?tenant=${encodeURIComponent(tenant)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(values),
  });
  if (response.ok) return { status: 'sent' };
  if (response.status !== 403) return { status: 'failed' };
  const refusal = (await response.json()) as TransferRefusal;
  switch (refusal.code) {
    case 'approval_required':
      return { status: 'approval', transfer: refusal.transfer };
    case 'strong_auth_required':
      return { status: 'editing', needsCode: true };
    case 'invalid_code':
      return { status: 'editing', needsCode: true, notice: refusal.error };
    case 'denied':
      return { status: 'denied' };
  }
}

function useRecipients(currentTenant: string): Recipient[] | null {
  const [recipients, setRecipients] = useState<Recipient[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/account/api/tenants/all')
      .then(async (response) => (response.ok ? ((await response.json()) as Recipient[]) : []))
      .then(
        (all) => {
          if (!cancelled) setRecipients(all.filter(({ key }) => key !== currentTenant));
        },
        () => {
          if (!cancelled) setRecipients([]);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [currentTenant]);
  return recipients;
}

function WireTransfer({ tenant }: { tenant: string }) {
  const recipients = useRecipients(tenant);
  const { reload } = useTransactions();
  const [outcome, setOutcome] = useState<Outcome>({ status: 'editing', needsCode: false });
  const [pending, startTransition] = useTransition();

  const submit = (values: TransferValues) => {
    startTransition(async () => {
      const next = await sendTransfer(tenant, values).catch((): Outcome => ({ status: 'failed' }));
      setOutcome(next);
      if (next.status === 'sent') reload();
    });
  };

  if (recipients === null) return <Skeleton active />;
  switch (outcome.status) {
    case 'sent':
      return <Alert type="success" title="Transfer sent" />;
    case 'denied':
      return <Alert type="error" title="You may not make this transfer" />;
    case 'failed':
      return <Alert type="error" title="The transfer failed" />;
    case 'approval':
      return (
        <PermitElement
          element={ELEMENTS.operationApproval}
          tenant={tenant}
          title="Ask for approval"
          options={{ resourceInstanceKey: outcome.transfer, tenantKey: tenant }}
        />
      );
    case 'editing':
      return (
        <Form<TransferValues> layout="vertical" onFinish={submit} disabled={pending}>
          <Form.Item label="To account" name="to" rules={[{ required: true }]}>
            <Select
              placeholder="Select an account"
              notFoundContent="No other accounts"
              options={recipients.map(({ key, name }) => ({ value: key, label: name }))}
            />
          </Form.Item>
          <Form.Item label="Description" name="description" rules={[{ required: true, max: 200 }]}>
            <Input />
          </Form.Item>
          <Form.Item label="Amount (£)" name="amount" rules={[{ required: true }]}>
            <InputNumber min={0.01} max={1_000_000} precision={2} className="!w-full" />
          </Form.Item>
          {outcome.needsCode ? (
            <>
              <p className="mb-2">
                This transfer needs a one-time code. We sent one to your email address (in this
                example, the code is in the app&apos;s log).
              </p>
              {outcome.notice === undefined ? null : (
                <Alert type="warning" title={outcome.notice} className="!mb-2" />
              )}
              <Form.Item
                label="One-time code"
                name="otp"
                rules={[{ required: true, pattern: /^\d{6}$/, message: 'Enter the 6-digit code' }]}
              >
                <Input inputMode="numeric" autoComplete="one-time-code" />
              </Form.Item>
            </>
          ) : null}
          <div className="flex justify-end">
            <Button type="primary" htmlType="submit" loading={pending}>
              Send
            </Button>
          </div>
        </Form>
      );
  }
}

/** The wire transfer dialog. It is rebuilt each time it opens, so every transfer starts clean. */
export function WireTransferModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { currentTenant } = useAccount();
  return (
    <Modal
      title="Send Wire Transfer"
      open={open}
      onCancel={onClose}
      footer={null}
      width={700}
      destroyOnHidden
      styles={{ body: { minHeight: 320, height: 'calc(100vh - 400px)', overflowY: 'auto' } }}
    >
      {currentTenant === null ? null : <WireTransfer tenant={currentTenant} />}
    </Modal>
  );
}
