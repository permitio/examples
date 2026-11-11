import { Wizard } from '@/components/wizard/Wizard';
import { WizardFormProvider } from '@/contexts/WizardFormContext';

export default function DelegatePermissionsPage() {
  return (
    <div className="p-8">
      <WizardFormProvider>
        <Wizard />
      </WizardFormProvider>
    </div>
  );
}
