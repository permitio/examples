import { describe, expect, it } from 'vitest';
import { ELEMENTS, elementUrl } from '@/lib/elements';

describe('elementUrl', () => {
  it("builds the element's iframe URL with the environment and its options", () => {
    expect(
      elementUrl('https://embed.permit.io', ELEMENTS.operationApproval, 'env-1', {
        resourceInstanceKey: 'w 1',
        tenantKey: 'alice-mesaverde-example',
      }),
    ).toBe(
      'https://embed.permit.io/wire-transfer-approval-request?envId=env-1&darkMode=false' +
        '&resourceInstanceKey=w+1&tenantKey=alice-mesaverde-example',
    );
  });
});
