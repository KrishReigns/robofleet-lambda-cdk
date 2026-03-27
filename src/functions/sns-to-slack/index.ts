/**
 * SNS-to-Slack Lambda Handler
 *
 * Purpose: Converts CloudWatch alarm notifications from SNS into formatted Slack messages
 * Routes system alerts and anomalies to the team's Slack channel
 *
 * Input: SNS message from CloudWatch alarms containing:
 * - AlarmName: Name of the alarm
 * - StateChangeReason: Why alarm triggered
 * - Trigger: Metric details
 * - StateUpdatedTimestamp: When alarm transitioned
 *
 * Output: Formatted Slack message in #robofleet-alerts channel
 *
 * Configuration: Slack webhook URL stored in Secrets Manager
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import https from 'https';

// Initialize Secrets Manager client
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION });

// Cache webhook URL to avoid repeated Secrets Manager calls
let cachedWebhookUrl: string | null = null;
const WEBHOOK_SECRET_NAME = 'robofleet/slack-webhook';

/**
 * Fetch Slack webhook URL from Secrets Manager
 */
async function getSlackWebhookUrl(): Promise<string> {
  if (cachedWebhookUrl) {
    return cachedWebhookUrl;
  }

  try {
    const getSecretCommand = new GetSecretValueCommand({
      SecretId: WEBHOOK_SECRET_NAME,
    });

    const response = await secretsClient.send(getSecretCommand);
    const secretValue = response.SecretString || response.SecretBinary?.toString();

    if (!secretValue) {
      throw new Error('Secret value is empty');
    }

    // Secret stored as JSON: {"slack_webhook_url": "https://hooks.slack.com/..."}
    const secret = typeof secretValue === 'string' ? JSON.parse(secretValue) : secretValue;
    cachedWebhookUrl = secret.slack_webhook_url;

    if (!cachedWebhookUrl) {
      throw new Error('slack_webhook_url not found in secret');
    }

    return cachedWebhookUrl;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Failed to retrieve Slack webhook URL', {
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
 * Format SNS alarm message into Slack message
 */
function formatSlackMessage(snsMessage: SNSMessage): {
  text: string;
  blocks: any[];
} {
  const alarmState = snsMessage.NewStateValue;
  const color = alarmState === 'ALARM' ? '#DC143C' : alarmState === 'OK' ? '#32CD32' : '#FFA500';
  const emoji = alarmState === 'ALARM' ? '🚨' : alarmState === 'OK' ? '✅' : '⚠️';

  const trigger = snsMessage.Trigger;
  const dimensionStr =
    trigger?.Dimensions?.map((d) => `${d.name}: ${d.value}`).join(', ') || 'N/A';

  return {
    text: `${emoji} ${snsMessage.AlarmName} - ${alarmState}`,
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${emoji} CloudWatch Alarm: ${snsMessage.AlarmName}`,
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Status*\n${alarmState}`,
          },
          {
            type: 'mrkdwn',
            text: `*Time*\n${new Date(snsMessage.StateUpdatedTimestamp).toLocaleString()}`,
          },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Reason*\n${snsMessage.StateChangeReason}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Metric*\n${trigger?.MetricName || 'N/A'}\n*Statistic*\n${trigger?.Statistic || 'N/A'}\n*Dimensions*\n${dimensionStr}`,
        },
      },
      {
        type: 'divider',
      },
    ],
  };
}

/**
 * Send message to Slack webhook
 */
function sendToSlack(webhookUrl: string, message: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(message);

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
      },
    };

    const req = https.request(webhookUrl, options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log('Message sent to Slack successfully');
          resolve();
        } else {
          reject(
            new Error(
              `Slack API returned status ${res.statusCode}: ${data}`
            )
          );
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Main Lambda handler
 */
export const handler = async (event: any) => {
  const startTime = Date.now();

  try {
    console.log('SNS-to-Slack Lambda invoked');

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

    // Get Slack webhook URL
    const webhookUrl = await getSlackWebhookUrl();

    // Format message for Slack
    const slackMessage = formatSlackMessage(snsMessage);

    // Send to Slack
    await sendToSlack(webhookUrl, slackMessage);

    const duration = Date.now() - startTime;

    console.log('Slack notification sent', {
      alarmName: snsMessage.AlarmName,
      processingDurationMs: duration,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Notification sent to Slack',
        alarmName: snsMessage.AlarmName,
        processingDurationMs: duration,
      }),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    console.error('Failed to send Slack notification', {
      error: errorMessage,
      processingDurationMs: duration,
      stack: error instanceof Error ? error.stack : undefined,
    });

    // Don't fail the Lambda - SNS will retry automatically
    // We just log the error and return success so SNS doesn't re-invoke
    return {
      statusCode: 200,
      body: JSON.stringify({
        warning: 'Failed to send Slack notification',
        message: errorMessage,
        processingDurationMs: duration,
      }),
    };
  }
};
