import { Button, CloseButton, Dialog, Portal, Text } from '@chakra-ui/react';
import { useState, useTransition } from 'react';
import { otherPlan, type Plan } from '#lib/model';

interface ChangePlanDialogProps {
  customerName: string;
  plan: Plan | null;
  /** Asks the API to change the plan. The dialog closes when it settles, allowed or not. */
  onConfirm: (plan: Plan) => Promise<void>;
}

/** The "Change plan" button, and the dialog that confirms the change. */
export function ChangePlanDialog({ customerName, plan, onConfirm }: ChangePlanDialogProps) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const next = otherPlan(plan);

  const confirm = () =>
    startTransition(async () => {
      await onConfirm(next);
      setOpen(false);
    });

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(details) => setOpen(details.open)}
      placement="center"
      size="sm"
    >
      <Dialog.Trigger asChild>
        <Button size="xs" colorPalette="blue">
          Change plan
        </Button>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content>
            <Dialog.Header>
              <Dialog.Title>Change plan</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Text fontSize="sm">
                {customerName} is on the {plan ?? 'no'} plan. Move them to {next}?
              </Text>
            </Dialog.Body>
            <Dialog.Footer>
              <Dialog.ActionTrigger asChild>
                <Button size="xs" variant="ghost">
                  Cancel
                </Button>
              </Dialog.ActionTrigger>
              <Button size="xs" colorPalette="blue" loading={isPending} onClick={confirm}>
                {next === 'VIP' ? 'Upgrade to VIP' : 'Downgrade to Standard'}
              </Button>
            </Dialog.Footer>
            <Dialog.CloseTrigger asChild>
              <CloseButton size="sm" />
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
