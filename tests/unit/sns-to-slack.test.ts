/**
 * Unit Tests for SNS-to-Slack Lambda
 *
 * We test two things:
 * 1. formatSlackMessage() — pure formatting logic, no AWS needed
 * 2. handler() — full flow with mocked Secrets Manager and https
 */

import { formatSlackMessage, handler } from '../../src/functions/sns-to-slack';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { mockClient } from 'aws-sdk-client-mock';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

// ============================================================
// MOCK SETUP
// ============================================================

// aws-sdk-client-mock lets us fake AWS SDK responses.
// Instead of calling real Secrets Manager, it returns what we tell it to.
const secretsMock = mockClient(SecretsManagerClient);

// Mock the https module so we don't make real HTTP calls to Slack
jest.mock('https', () => ({
  request: jest.fn((_url, _options, callback) => {
    // Simulate a successful Slack response (status 200)
    const mockResponse = {
      statusCode: 200,
      on: jest.fn((event, cb) => {
        if (event === 'end') cb();
        return mockResponse;
      }),
    };
    callback(mockResponse);
    return {
      on: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
    };
  }),
}));

// A reusable sample alarm message — used across multiple tests
const sampleAlarm = {
  AlarmName: 'robofleet-high-error-rate',
  AlarmDescription: 'Too many errors',
  NewStateValue: 'ALARM',
  StateChangeReason: 'Threshold crossed: 6 errors in 5 minutes',
  StateUpdatedTimestamp: '2026-03-29T10:00:00Z',
  Trigger: {
    MetricName: 'Errors',
    Namespace: 'AWS/Lambda',
    Statistic: 'Sum',
    Unit: 'Count',
    Dimensions: [{ name: 'FunctionName', value: 'robofleet-ingest' }],
  },
};

// A helper that wraps an alarm into the SNS event structure Lambda receives
const makeSNSEvent = (alarm: object) => ({
  Records: [{ Sns: { Message: JSON.stringify(alarm) } }],
});

// ============================================================
// TESTS: formatSlackMessage()
// ============================================================

describe('formatSlackMessage()', () => {

  it('should include the alarm name in the message text', () => {
    // Call the formatting function directly
    const result = formatSlackMessage(sampleAlarm);

    // The top-level "text" field should contain the alarm name
    // This is what Slack shows as a notification preview
    expect(result.text).toContain('robofleet-high-error-rate');
  });

  it('should use 🚨 emoji for ALARM state', () => {
    const result = formatSlackMessage(sampleAlarm);
    expect(result.text).toContain('🚨');
  });

  it('should use ✅ emoji for OK state', () => {
    const result = formatSlackMessage({ ...sampleAlarm, NewStateValue: 'OK' });
    expect(result.text).toContain('✅');
  });

  it('should use ⚠️ emoji for INSUFFICIENT_DATA state', () => {
    const result = formatSlackMessage({ ...sampleAlarm, NewStateValue: 'INSUFFICIENT_DATA' });
    expect(result.text).toContain('⚠️');
  });

  it('should include the state reason in the blocks', () => {
    const result = formatSlackMessage(sampleAlarm);

    // blocks is an array of Slack Block Kit sections
    // Convert to string to easily search all block content
    const blocksStr = JSON.stringify(result.blocks);
    expect(blocksStr).toContain('Threshold crossed: 6 errors in 5 minutes');
  });

  it('should include the metric name in the blocks', () => {
    const result = formatSlackMessage(sampleAlarm);
    const blocksStr = JSON.stringify(result.blocks);
    expect(blocksStr).toContain('Errors');
  });

  it('should include dimension info in the blocks', () => {
    const result = formatSlackMessage(sampleAlarm);
    const blocksStr = JSON.stringify(result.blocks);
    expect(blocksStr).toContain('robofleet-ingest');
  });

  it('should handle missing Trigger gracefully', () => {
    // Some alarms may not have a Trigger field
    const alarmWithoutTrigger = { ...sampleAlarm, Trigger: undefined };
    const result = formatSlackMessage(alarmWithoutTrigger);

    // Should still produce a valid message with N/A fallbacks
    const blocksStr = JSON.stringify(result.blocks);
    expect(blocksStr).toContain('N/A');
  });

  it('should always return blocks array with at least 3 items', () => {
    const result = formatSlackMessage(sampleAlarm);
    // header + status section + reason section + metric section + divider = 5
    expect(result.blocks.length).toBeGreaterThanOrEqual(3);
  });
});

// ============================================================
// TESTS: handler()
// ============================================================

describe('handler()', () => {

  beforeEach(() => {
    // Reset all mocks before each test so they don't interfere
    secretsMock.reset();
    jest.clearAllMocks();

    // Tell the Secrets Manager mock what to return when asked for the webhook URL
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({ slack_webhook_url: 'https://hooks.slack.com/test' }),
    });
  });

  it('should return 200 on success', async () => {
    const result = await handler(makeSNSEvent(sampleAlarm));
    expect(result.statusCode).toBe(200);
  });

  it('should return 200 even when Slack call fails (SNS retry protection)', async () => {
    // If Slack fails, the Lambda should still return 200
    // This prevents SNS from retrying and spamming the channel
    const https = require('https');
    https.request.mockImplementationOnce((_url: any, _options: any, callback: any) => {
      const mockResponse = {
        statusCode: 400,
        on: jest.fn((event: string, cb: () => void) => {
          if (event === 'data') cb();
          if (event === 'end') cb();
          return mockResponse;
        }),
      };
      callback(mockResponse);
      return { on: jest.fn(), write: jest.fn(), end: jest.fn() };
    });

    const result = await handler(makeSNSEvent(sampleAlarm));
    expect(result.statusCode).toBe(200);
  });

  it('should return 200 with warning when SNS event is malformed', async () => {
    // Missing Records field — invalid event structure
    const result = await handler({});
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.warning).toBeDefined();
  });

  it('should include alarm name in response body on success', async () => {
    const result = await handler(makeSNSEvent(sampleAlarm));
    const body = JSON.parse(result.body);
    expect(body.alarmName).toBe('robofleet-high-error-rate');
  });
});
