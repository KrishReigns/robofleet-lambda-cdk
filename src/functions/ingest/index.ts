/**
 * Ingest Lambda Handler
 *
 * Purpose: Receives device telemetry data and stores it in the S3 data lake
 * with proper partitioning by year/month/day for efficient querying via Athena
 *
 * Input: Raw telemetry event containing:
 * - device_id: Unique device identifier
 * - temperature: Current device temperature
 * - humidity: Current humidity level
 * - pressure: Atmospheric pressure
 * - timestamp: Event timestamp (optional - will use current time if not provided)
 * - additional metadata fields...
 *
 * Output: S3 object stored at:
 * s3://robofleet-data-lake-{account}/telemetry/{year}/{month}/{day}/{hour}/device-{deviceId}-{timestamp}.csv
 *
 * Error Handling: Logs errors to CloudWatch, throws exception on failure
 */

import {
  S3Client,
  PutObjectCommand,
  PutObjectCommandInput,
} from '@aws-sdk/client-s3';

// Initialize AWS SDK clients
const s3Client = new S3Client({ region: process.env.AWS_REGION });

// Get environment variables
const DATA_LAKE_BUCKET = process.env.DATA_LAKE_BUCKET || 'robofleet-data-lake';
const LOG_GROUP = '/aws/lambda/ingest';

/**
 * Type definitions for telemetry data
 */
interface TelemetryEvent {
  device_id: string;
  temperature: number;
  humidity: number;
  pressure: number;
  timestamp?: number;
  [key: string]: any; // Allow additional fields
}

interface LambdaEvent {
  body?: string;
  [key: string]: any;
}

/**
 * Format telemetry data as CSV for S3 storage
 * This format will be parsed by Glue Crawler
 */
function formatAsCSV(telemetry: TelemetryEvent): string {
  const timestamp = telemetry.timestamp || Date.now();
  return [
    telemetry.device_id,
    telemetry.temperature,
    telemetry.humidity,
    telemetry.pressure,
    timestamp,
    new Date(timestamp).toISOString(),
  ].join(',');
}

/**
 * Generate S3 partition path based on timestamp
 * Path: telemetry/{year}/{month}/{day}/{hour}/
 */
function getPartitionPath(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');

  return `telemetry/year=${year}/month=${month}/day=${day}/hour=${hour}`;
}

/**
 * Generate unique S3 object key
 */
function generateObjectKey(
  deviceId: string,
  timestamp: number,
  partitionPath: string
): string {
  // Format: telemetry/year=2024/month=03/day=27/hour=14/device-{deviceId}-{timestamp}.csv
  return `${partitionPath}/device-${deviceId}-${timestamp}.csv`;
}

/**
 * Main Lambda handler
 */
export const handler = async (event: LambdaEvent) => {
  const startTime = Date.now();
  let telemetry: TelemetryEvent | undefined;

  try {
    console.log('Ingest Lambda invoked', {
      eventSource: event.Records?.[0]?.eventSource || 'direct',
      timestamp: new Date().toISOString(),
    });

    // Parse incoming telemetry data
    // Support both direct invocation and API Gateway/SNS events
    if (typeof event.body === 'string') {
      telemetry = JSON.parse(event.body);
    } else if (event.Records && event.Records[0]?.Sns) {
      // SNS event
      telemetry = JSON.parse(event.Records[0].Sns.Message);
    } else {
      // Direct invocation
      telemetry = event as TelemetryEvent;
    }

    // Guard against undefined telemetry
    if (!telemetry) {
      throw new Error('Failed to parse telemetry data');
    }

    // Validate required fields
    if (!telemetry.device_id) {
      throw new Error('Missing required field: device_id');
    }
    if (typeof telemetry.temperature !== 'number') {
      throw new Error('Missing or invalid field: temperature');
    }
    if (typeof telemetry.humidity !== 'number') {
      throw new Error('Missing or invalid field: humidity');
    }
    if (typeof telemetry.pressure !== 'number') {
      throw new Error('Missing or invalid field: pressure');
    }

    // Add current timestamp if not provided
    const timestamp = telemetry.timestamp || Date.now();
    telemetry.timestamp = timestamp;

    // Generate S3 path and key
    const partitionPath = getPartitionPath(timestamp);
    const objectKey = generateObjectKey(telemetry.device_id, timestamp, partitionPath);

    // Format data as CSV
    const csvData = formatAsCSV(telemetry);

    // Upload to S3
    const putParams: PutObjectCommandInput = {
      Bucket: DATA_LAKE_BUCKET,
      Key: objectKey,
      Body: csvData,
      ContentType: 'text/csv',
      ServerSideEncryption: 'aws:kms', // Required by security policy
      Metadata: {
        'device-id': telemetry.device_id,
        'ingestion-timestamp': new Date().toISOString(),
      },
    };

    const putCommand = new PutObjectCommand(putParams);
    const s3Response = await s3Client.send(putCommand);

    const duration = Date.now() - startTime;

    console.log('Telemetry stored successfully', {
      deviceId: telemetry.device_id,
      s3Bucket: DATA_LAKE_BUCKET,
      s3Key: objectKey,
      eTag: s3Response.ETag,
      processingDurationMs: duration,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Telemetry ingested successfully',
        deviceId: telemetry.device_id,
        s3Location: `s3://${DATA_LAKE_BUCKET}/${objectKey}`,
        processingDurationMs: duration,
      }),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    console.error('Error ingesting telemetry', {
      error: errorMessage,
      deviceId: telemetry?.device_id || 'unknown',
      processingDurationMs: duration,
      stack: error instanceof Error ? error.stack : undefined,
    });

    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'Failed to ingest telemetry',
        message: errorMessage,
        processingDurationMs: duration,
      }),
    };
  }
};
