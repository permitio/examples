'use client';

import { Button, Modal } from 'antd';
import { useState } from 'react';
import { useAbilities } from '@/components/AbilityContext';
import { useAccount } from '@/components/AccountContext';
import { PermitElement } from '@/components/PermitElement';
import { WireTransferModal } from '@/components/WireTransferModal';
import { ELEMENTS } from '@/lib/elements';

type ModalType = 'wire-transfer' | 'access-request' | 'user-management' | 'approval-list';

const ELEMENT_MODAL_BODY = { body: { height: 'calc(100vh - 200px)', overflowY: 'auto' } } as const;

/** The actions the user may take in the account; each button shows only when Permit allows it. */
export function AccountToolbar() {
  const { currentTenant } = useAccount();
  const abilities = useAbilities();
  const [activeModal, setActiveModal] = useState<ModalType | null>(null);
  const close = () => setActiveModal(null);

  if (currentTenant === null) return null;
  return (
    <div className="flex flex-wrap gap-4">
      {abilities?.CREATE_WIRE_TRANSFER === true ? (
        <Button type="primary" onClick={() => setActiveModal('wire-transfer')}>
          Send Wire Transfer
        </Button>
      ) : null}
      {abilities?.ADD_MEMBERS === true ? (
        <Button type="default" onClick={() => setActiveModal('user-management')}>
          Manage Account Users
        </Button>
      ) : null}
      {abilities !== null && !abilities.LIST_TRANSACTIONS ? (
        <Button type="primary" onClick={() => setActiveModal('access-request')}>
          Request Access to Transactions
        </Button>
      ) : null}
      {abilities?.APPROVE_WIRE_TRANSFER === true ? (
        <Button type="primary" onClick={() => setActiveModal('approval-list')}>
          Review Wire Transfers
        </Button>
      ) : null}

      <Modal
        title="Review Wire Transfers"
        open={activeModal === 'approval-list'}
        onCancel={close}
        footer={null}
        width={1200}
        destroyOnHidden
        styles={ELEMENT_MODAL_BODY}
      >
        <PermitElement
          element={ELEMENTS.approvalManagement}
          tenant={currentTenant}
          title="Wire transfer approvals"
        />
      </Modal>
      <Modal
        title="Manage Account Users and Review Requests"
        open={activeModal === 'user-management'}
        onCancel={close}
        footer={null}
        width={700}
        destroyOnHidden
        styles={ELEMENT_MODAL_BODY}
      >
        <PermitElement
          element={ELEMENTS.userManagement}
          tenant={currentTenant}
          title="Account members"
        />
      </Modal>
      <Modal
        title="Request Access to Account"
        open={activeModal === 'access-request'}
        onCancel={close}
        footer={null}
        width={700}
        destroyOnHidden
        styles={ELEMENT_MODAL_BODY}
      >
        <PermitElement
          element={ELEMENTS.accessRequest}
          tenant={currentTenant}
          title="Request access"
          options={{ tenantKey: currentTenant }}
        />
      </Modal>
      <WireTransferModal open={activeModal === 'wire-transfer'} onClose={close} />
    </div>
  );
}
