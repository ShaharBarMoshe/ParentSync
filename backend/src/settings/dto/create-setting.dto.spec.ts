import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateSettingDto } from './create-setting.dto';

async function validateKey(key: string, value = 'true') {
  const dto = plainToInstance(CreateSettingDto, { key, value });
  return validate(dto);
}

describe('CreateSettingDto', () => {
  // Regression guard: these keys are seeded/read by the backend AND exposed as
  // editable controls in the frontend SettingsPage. If any drops out of
  // ALLOWED_SETTING_KEYS, saving settings fails with a 400 (see the whole-form
  // save loop in SettingsPage.handleSubmit).
  const userSettableKeys = [
    'check_schedule',
    'gemini_api_key',
    'gemini_model',
    'google_client_id',
    'google_client_secret',
    'google_redirect_uri',
    'approval_channel',
    'dedup_enabled',
    'dedup_threshold',
    'classifier_enabled',
    'smoke_test_enabled',
  ];

  it.each(userSettableKeys)('accepts user-settable key "%s"', async (key) => {
    const errors = await validateKey(key);
    expect(errors).toHaveLength(0);
  });

  it('rejects an unknown key', async () => {
    const errors = await validateKey('not_a_real_setting');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].constraints).toHaveProperty('isIn');
  });

  it('trims whitespace from the value', () => {
    const dto = plainToInstance(CreateSettingDto, {
      key: 'gemini_model',
      value: '  gemini-2.0-flash  ',
    });
    expect(dto.value).toBe('gemini-2.0-flash');
  });
});
