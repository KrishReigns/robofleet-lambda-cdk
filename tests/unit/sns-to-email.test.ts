/**
 * Unit Tests for SNS-to-Email Lambda
 *
 * We test three things:
 * 1. formatEmailHTML() — HTML email body generation
 * 2. formatEmailText() — plain text email body generation
 * 3. handler() — full flow with mocked Secrets Manager and SES
 */

import { formatEmailHTML, formatEmailText, handler } from '../../src/functions/sns-to-email';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SESClient } from '@aws-sdk/client-ses';
import { mockClient } from 'aws-sdk-client-mock';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SendEmailCommand } from '@aws-sdk/client-ses';

// ============================================================
// MOCK SETUP
// ============================================================

const secretsMock = mockClient(SecretsManagerClient);
const sesMock = mockClient(SESClient);

// A reusable sample alarm used across all tests
const sampleAlarm = {
  AlarmName: 'robofleet-slow-queries',
  AlarmDescription: 'Queries taking too long',
  NewStateValue: 'ALARM',
  StateChangeReason: 'Average duration exceeded 30 seconds',
  StateUpdatedTimestamp: '2026-03-29T10:00:00Z',
  Trigger: {
    MetricName: 'Duration',
    Namespace: 'AWS/Lambda',
    Statistic: 'Average',
    Unit: 'Milliseconds',
    Dimensions: [{ name: 'FunctionName', value: 'robofleet-query' }],
  },
};

const makeSNSEvent = (alarm: object) => ({
  Records: [{ Sns: { Message: JSON.stringify(alarm) } }],
});

// ============================================================
// TESTS: formatEmailHTML()
// ============================================================

describe('formatEmailHTML()', () => {

  it('should return a valid HTML string', () => {
    const html = formatEmailHTML(sampleAlarm);
    // Every HTML email should start with DOCTYPE and contain html tags
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html>');
    expect(html).toContain('</html>');
  });

  it('should include the alarm name in the HTML', () => {
    const html = formatEmailHTML(sampleAlarm);
    expect(html).toContain('robofleet-slow-queries');
  });

  it('should include the state reason in the HTML', () => {
    const html = formatEmailHTML(sampleAlarm);
    expect(html).toContain('Average duration exceeded 30 seconds');
  });

  it('should use red color (#DC143C) for ALARM state', () => {
    const html = formatEmailHTML(sampleAlarm);
    // The header background color should be red for ALARM
    expect(html).toContain('#DC143C');
  });

  it('should use green color (#32CD32) for OK state', () => {
    const html = formatEmailHTML({ ...sampleAlarm, NewStateValue: 'OK' });
    expect(html).toContain('#32CD32');
  });

  it('should use orange color (#FFA500) for INSUFFICIENT_DATA state', () => {
    const html = formatEmailHTML({ ...sampleAlarm, NewStateValue: 'INSUFFICIENT_DATA' });
    expect(html).toContain('#FFA500');
  });

  it('should include metric details in the HTML', () => {
    const html = formatEmailHTML(sampleAlarm);
    expect(html).toContain('Duration');
    expect(html).toContain('AWS/Lambda');
    expect(html).toContain('Average');
  });

  it('should include dimension info in the HTML', () => {
    const html = formatEmailHTML(sampleAlarm);
    expect(html).toContain('robofleet-query');
  });

  it('should show N/A when Trigger is missing', () => {
    const html = formatEmailHTML({ ...sampleAlarm, Trigger: undefined });
    expect(html).toContain('N/A');
  });
});

// ============================================================
// TESTS: formatEmailText()
// ============================================================

describe('formatEmailText()', () => {

  it('should include the alarm name', () => {
    const text = formatEmailText(sampleAlarm);
    expect(text).toContain('robofleet-slow-queries');
  });

  it('should include the state value', () => {
    const text = formatEmailText(sampleAlarm);
    expect(text).toContain('ALARM');
  });

  it('should include the state reason', () => {
    const text = formatEmailText(sampleAlarm);
    expect(text).toContain('Average duration exceeded 30 seconds');
  });

  it('should include metric name', () => {
    const text = formatEmailText(sampleAlarm);
    expect(text).toContain('Duration');
  });

  it('should include the automated alert footer', () => {
    const text = formatEmailText(sampleAlarm);
    expect(text).toContain('automated alert');
  });

  it('should show N/A when Trigger is missing', () => {
    const text = formatEmailText({ ...sampleAlarm, Trigger: undefined });
    expect(text).toContain('N/A');
  });
});

// ============================================================
// TESTS: handler()
// ============================================================

describe('handler()', () => {

  beforeEach(() => {
    secretsMock.reset();
    sesMock.reset();

    // Mock Secrets Manager to return email config
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify({
        sender_email: 'sender@example.com',
        recipient_emails: ['recipient@example.com'],
      }),
    });

    // Mock SES to simulate a successful email send
    sesMock.on(SendEmailCommand).resolves({
      MessageId: 'test-message-id-123',
    });
  });

  it('should return 200 on success', async () => {
    const result = await handler(makeSNSEvent(sampleAlarm));
    expect(result.statusCode).toBe(200);
  });

  it('should include alarm name in response body', async () => {
    const result = await handler(makeSNSEvent(sampleAlarm));
    const body = JSON.parse(result.body);
    expect(body.alarmName).toBe('robofleet-slow-queries');
  });

  it('should return 200 with warning when event is malformed', async () => {
    // Missing Records — invalid SNS event
    const result = await handler({});
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.warning).toBeDefined();
  });

  it('should return 200 even when SES fails (SNS retry protection)', async () => {
    // Override SES mock to throw an error
    sesMock.on(SendEmailCommand).rejects(new Error('SES service unavailable'));

    const result = await handler(makeSNSEvent(sampleAlarm));
    // Should still return 200 to prevent SNS from retrying
    expect(result.statusCode).toBe(200);
  });

  it('should call SES exactly once per invocation', async () => {
    await handler(makeSNSEvent(sampleAlarm));
    // Verify SES was called exactly once (not zero, not multiple times)
    const sesCalls = sesMock.calls();
    expect(sesCalls.length).toBe(1);
  });
});
