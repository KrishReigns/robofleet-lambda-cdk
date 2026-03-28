/**
 * Ingest Lambda Handler
 *
 * Purpose: Receives device telemetry data and stores it in the S3 data lake
 * with proper partitioning by year/month/day for efficient querying via Athena
 *
 * Input:
 * - device_id (string): Unique device identifier
 * - fleet_id (string): Fleet grouping identifier
 * - battery_level (number): Battery percentage 0-100
 * - speed_mps (number): Speed in meters per second
 * - status (string): IDLE | MOVING | CHARGING | ERROR
 * - error_code (string, optional): Error code if status=ERROR
 * - location_zone (string): Current zone identifier
 * - temperature_celsius (number): Device temperature
 * - event_time (string, optional): ISO 8601 timestamp — defaults to now
 *
 * Output: S3 object at:
 * s3://robofleet-data-lake-{account}/telemetry/year={Y}/month={MM}/day={DD}/hour={HH}/device-{deviceId}-{timestamp}.csv
 */

import {
  S3Client,
  PutObjectCommand,
  PutObjectCommandInput,
} from '@aws-sdk/client-s3';

const s3Client = new S3Client({ region: process.env.AWS_REGION });

const DATA_LAKE_BUCKET = process.env.DATA_LAKE_BUCKET || 'robofleet-data-lake';

interface TelemetryEvent {
  device_id: string;
  fleet_id: string;
  battery_level: number;
  speed_mps: number;
  status: string;
  error_code?: string;
  location_zone: string;
  temperature_celsius: number;
  event_time?: string;
}

interface LambdaEvent {
  body?: string;
  [key: string]: any;
}

function formatAsCSV(telemetry: TelemetryEvent): string {
  return [
    telemetry.device_id,
    telemetry.fleet_id,
    telemetry.event_time,
    telemetry.battery_level,
    telemetry.speed_mps,
    telemetry.status,
    telemetry.error_code ?? '',
    telemetry.location_zone,
    telemetry.temperature_celsius,
  ].join(',');
}

function getPartitionPath(isoTime: string): string {
  const date = new Date(isoTime);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  return `telemetry/year=${year}/month=${month}/day=${day}/hour=${hour}`;
}

export const handler = async (event: LambdaEvent) => {
  const startTime = Date.now();
  let telemetry: TelemetryEvent | undefined;

  try {
    console.log('Ingest Lambda invoked', {
      eventSource: event.Records?.[0]?.eventSource || 'direct',
      timestamp: new Date().toISOString(),
    });

    if (typeof event.body === 'string') {
      telemetry = JSON.parse(event.body);
    } else if (event.Records?.[0]?.Sns) {
      telemetry = JSON.parse(event.Records[0].Sns.Message);
    } else {
      telemetry = event as TelemetryEvent;
    }

    if (!telemetry) throw new Error('Failed to parse telemetry data');

    // Validate required fields
    if (!telemetry.device_id) throw new Error('Missing required field: device_id');
    if (!telemetry.fleet_id) throw new Error('Missing required field: fleet_id');
    if (typeof telemetry.battery_level !== 'number') throw new Error('Missing or invalid field: battery_level');
    if (typeof telemetry.speed_mps !== 'number') throw new Error('Missing or invalid field: speed_mps');
    if (!telemetry.status) throw new Error('Missing required field: status');
    if (!telemetry.location_zone) throw new Error('Missing required field: location_zone');
    if (typeof telemetry.temperature_celsius !== 'number') throw new Error('Missing or invalid field: temperature_celsius');

    telemetry.event_time = telemetry.event_time || new Date().toISOString();

    const partitionPath = getPartitionPath(telemetry.event_time);
    const timestamp = Date.now();
    const objectKey = `${partitionPath}/device-${telemetry.device_id}-${timestamp}.csv`;
    const csvData = formatAsCSV(telemetry);

    const putParams: PutObjectCommandInput = {
      Bucket: DATA_LAKE_BUCKET,
      Key: objectKey,
      Body: csvData,
      ContentType: 'text/csv',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: process.env.KMS_KEY_ARN,
      Metadata: {
        'device-id': telemetry.device_id,
        'ingestion-timestamp': new Date().toISOString(),
      },
    };

    const s3Response = await s3Client.send(new PutObjectCommand(putParams));
    const duration = Date.now() - startTime;

    console.log('Telemetry stored successfully', {
      deviceId: telemetry.device_id,
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
