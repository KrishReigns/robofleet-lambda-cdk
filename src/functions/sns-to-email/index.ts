/**
 * SNS-to-Email Lambda Handler
 *
 * Purpose: Converts CloudWatch alarm notifications from SNS into email messages
 * Routes critical alerts via AWS SES (Simple Email Service)
 *
 * Input: SNS message from CloudWatch alarms
 * - AlarmName: Name of the alarm
 * - StateChangeReason: Why alarm triggered
 * - Trigger: Metric details
 *
 * Output: Email sent via SES to configured recipients
 *
 * Configuration: Email recipients and sender stored in Secrets Manager
 */

import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

// Initialize AWS SDK clients
const sesClient = new SESClient({ region: process.env.AWS_REGION });
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION });

// Environment variables
const EMAIL_CONFIG_SECRET = 'robofleet/email-config';

// Cache email config
let cachedEmailConfig: any = null;

/**
 * Fetch email configuration from Secrets Manager
 */
async function getEmailConfig(): Promise<{
  sender_email: string;
  recipient_emails: string[];
}> {
  if (cachedEmailConfig) {
    return cachedEmailConfig;
  }

  try {
    const getSecretCommand = new GetSecretValueCommand({
      SecretId: EMAIL_CONFIG_SECRET,
    });

    const response = await secretsClient.send(getSecretCommand);
    const secretValue = response.SecretString || response.SecretBinary?.toString();

    if (!secretValue) {
      throw new Error('Secret value is empty');
    }

    cachedEmailConfig =
      typeof secretValue === 'string' ? JSON.parse(secretValue) : secretValue;

    if (!cachedEmailConfig.sender_email || !cachedEmailConfig.recipient_emails) {
      throw new Error('Missing sender_email or recipient_emails in secret');
    }

    return cachedEmailConfig;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Failed to retrieve email configuration', {
      error: errorMessage,
    });
    throw error;
  }
}

/**
 * Type definitions
 */
interface SNSMessage {
  AlarmName: string;
  AlarmDescription?: string;
  StateChangeReason: string;
  StateUpdatedTimestamp: string;
  NewStateValue: string;
  NewStateReason?: string;
  Trigger?: {
    MetricName: string;
    Namespace: string;
    Statistic: string;
    Unit: string;
    Dimensions: Array<{
      name: string;
      value: string;
    }>;
  };
}

/**
 * Format alarm message as email HTML
 * Exported for unit testing
 */
export function formatEmailHTML(snsMessage: SNSMessage): string {
  const trigger = snsMessage.Trigger;
  const dimensionStr =
    trigger?.Dimensions?.map((d) => `<li>${d.name}: ${d.value}</li>`).join('') ||
    '<li>N/A</li>';

  const alarmState = snsMessage.NewStateValue;
  const stateColor = alarmState === 'ALARM' ? '#DC143C' : alarmState === 'OK' ? '#32CD32' : '#FFA500';

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #333; }
          .header { background-color: ${stateColor}; color: white; padding: 20px; border-radius: 5px; }
          .section { margin: 20px 0; }
          .label { font-weight: bold; color: #555; }
          .value { margin-left: 10px; }
          ul { list-style-type: none; padding: 0; }
          li { padding: 5px 0; }
          .timestamp { color: #999; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>${snsMessage.AlarmName}</h1>
          <p style="margin: 0; font-size: 18px;">State: ${alarmState}</p>
        </div>

        <div class="section">
          <p class="label">Alert Time:</p>
          <p class="value">${new Date(snsMessage.StateUpdatedTimestamp).toLocaleString()}</p>
        </div>

        <div class="section">
          <p class="label">Reason:</p>
          <p class="value">${snsMessage.StateChangeReason}</p>
        </div>

        <div class="section">
          <p class="label">Metric Details:</p>
          <ul>
            <li><strong>Name:</strong> ${trigger?.MetricName || 'N/A'}</li>
            <li><strong>Namespace:</strong> ${trigger?.Namespace || 'N/A'}</li>
            <li><strong>Statistic:</strong> ${trigger?.Statistic || 'N/A'}</li>
            <li><strong>Unit:</strong> ${trigger?.Unit || 'N/A'}</li>
          </ul>
        </div>

        <div class="section">
          <p class="label">Dimensions:</p>
          <ul>
            ${dimensionStr}
          </ul>
        </div>

        <div class="section timestamp">
          <p>This is an automated alert from Robofleet Monitoring System</p>
        </div>
      </body>
    </html>
  `;
}

/**
 * Format alarm message as plain text
 * Exported for unit testing
 */
export function formatEmailText(snsMessage: SNSMessage): string {
  const trigger = snsMessage.Trigger;
  const dimensionStr =
    trigger?.Dimensions?.map((d) => `  - ${d.name}: ${d.value}`).join('\n') || '  - N/A';

  return `
CLOUDWATCH ALARM NOTIFICATION

Alarm Name: ${snsMessage.AlarmName}
State: ${snsMessage.NewStateValue}
Time: ${new Date(snsMessage.StateUpdatedTimestamp).toLocaleString()}

Reason:
${snsMessage.StateChangeReason}

Metric Details:
  - Name: ${trigger?.MetricName || 'N/A'}
  - Namespace: ${trigger?.Namespace || 'N/A'}
  - Statistic: ${trigger?.Statistic || 'N/A'}
  - Unit: ${trigger?.Unit || 'N/A'}

Dimensions:
${dimensionStr}

---
This is an automated alert from Robofleet Monitoring System
  `.trim();
}

/**
 * Send email via SES
 */
async function sendEmail(
  senderEmail: string,
  recipientEmails: string[],
  subject: string,
  htmlBody: string,
  textBody: string
): Promise<void> {
  const sendEmailCommand = new SendEmailCommand({
    Source: senderEmail,
    Destination: {
      ToAddresses: recipientEmails,
    },
    Message: {
      Subject: {
        Data: subject,
        Charset: 'UTF-8',
      },
      Body: {
        Html: {
          Data: htmlBody,
          Charset: 'UTF-8',
        },
        Text: {
          Data: textBody,
          Charset: 'UTF-8',
        },
      },
    },
  });

  const response = await sesClient.send(sendEmailCommand);

  console.log('Email sent successfully', {
    messageId: response.MessageId,
    recipients: recipientEmails.length,
  });
}

/**
 * Main Lambda handler
 */
export const handler = async (event: any) => {
  const startTime = Date.now();

  try {
    console.log('SNS-to-Email Lambda invoked');

    // Extract SNS message from event
    if (!event.Records || !event.Records[0]?.Sns?.Message) {
      throw new Error('Invalid SNS event structure');
    }

    const snsMessageStr = event.Records[0].Sns.Message;
    const snsMessage: SNSMessage = JSON.parse(snsMessageStr);

    console.log('Processing alarm notification', {
      alarmName: snsMessage.AlarmName,
      state: snsMessage.NewStateValue,
    });

    // Get email configuration
    const emailConfig = await getEmailConfig();

    // Format email
    const subject = `[${snsMessage.NewStateValue}] ${snsMessage.AlarmName}`;
    const htmlBody = formatEmailHTML(snsMessage);
    const textBody = formatEmailText(snsMessage);

    // Send email
    await sendEmail(
      emailConfig.sender_email,
      emailConfig.recipient_emails,
      subject,
      htmlBody,
      textBody
    );

    const duration = Date.now() - startTime;

    console.log('Email notification sent', {
      alarmName: snsMessage.AlarmName,
      recipients: emailConfig.recipient_emails.length,
      processingDurationMs: duration,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Email notification sent',
        alarmName: snsMessage.AlarmName,
        processingDurationMs: duration,
      }),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    console.error('Failed to send email notification', {
      error: errorMessage,
      processingDurationMs: duration,
      stack: error instanceof Error ? error.stack : undefined,
    });

    // Don't fail the Lambda - SNS will retry automatically
    return {
      statusCode: 200,
      body: JSON.stringify({
        warning: 'Failed to send email notification',
        message: errorMessage,
        processingDurationMs: duration,
      }),
    };
  }
};
