import {
  isUsableApprovalMessageId,
  UNUSABLE_APPROVAL_MESSAGE_ID,
} from './approval-message-id';

describe('isUsableApprovalMessageId', () => {
  it('accepts a real WhatsApp message key', () => {
    expect(
      isUsableApprovalMessageId(
        'true_120363407443598263@g.us_3EB0A87880D02F4D93C750_255524885028964@lid',
      ),
    ).toBe(true);
  });

  /**
   * Several rows can hold this sentinel at once, so matching on it resolves to
   * an arbitrary one — the bug that made a 👍 approve the wrong event.
   */
  it('rejects the "[object Object]" sentinel', () => {
    expect(isUsableApprovalMessageId(UNUSABLE_APPROVAL_MESSAGE_ID)).toBe(false);
    expect(isUsableApprovalMessageId(' [object Object] ')).toBe(false);
  });

  it('rejects blank and non-string values', () => {
    expect(isUsableApprovalMessageId('')).toBe(false);
    expect(isUsableApprovalMessageId('   ')).toBe(false);
    expect(isUsableApprovalMessageId(null)).toBe(false);
    expect(isUsableApprovalMessageId(undefined)).toBe(false);
    expect(isUsableApprovalMessageId({} as unknown as string)).toBe(false);
  });
});
