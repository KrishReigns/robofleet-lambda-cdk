/**
 * Processing Lambda Handler
 *
 * Purpose: Processes raw telemetry data and optimizes it for Athena queries
 * This includes data aggregation, cleaning, and transformation
 *
 * Tasks:
 * - Read raw telemetry from S3 data lake
 * - Aggregate data (5-minute windows)
 * - Calculate statistics (min, max, avg)
 * - Clean outliers
 * - Write optimized data back to S3
 *
 * Input: CloudWatch Events trigger (scheduled)
 * - Processes data from the previous hour
 *
 * Output: Optimized parquet files in S3 for faster Athena queries
 */

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { GlueClient } from '@aws-sdk/client-glue';

// Initialize AWS SDK clients
const s3Client = new S3Client({ region: process.env.AWS_REGION });
const glueClient = new GlueClient({ region: process.env.AWS_REGION });

// Environment variables
const DATA_LAKE_BUCKET = process.env.DATA_LAKE_BUCKET || 'robofleet-data-lake';
const DATABASE = process.env.GLUE_DATABASE || 'robofleet_db';
const TABLE = 'device_telemetry';

/**
 * Type definitions
 */
export interface TelemetryRecord {
  device_id: string;
  temperature: number;
  humidity: number;
  pressure: number;
  timestamp: number;
  iso_timestamp: string;
}

export interface AggregatedData {
  device_id: string;
  window_start: number;
  window_end: number;
  temperature_avg: number;
  temperature_min: number;
  temperature_max: number;
  humidity_avg: number;
  humidity_min: number;
  humidity_max: number;
  pressure_avg: number;
  pressure_min: number;
  pressure_max: number;
  record_count: number;
  processed_at: string;
}

/**
 * Get hour to process (previous hour)
 * Exported for unit testing
 */
export function getHourToProcess(): {
  year: string;
  month: string;
  day: string;
  hour: string;
} {
  const now = new Date();
  now.setUTCHours(now.getUTCHours() - 1);

  return {
    year: String(now.getUTCFullYear()),
    month: String(now.getUTCMonth() + 1).padStart(2, '0'),
    day: String(now.getUTCDate()).padStart(2, '0'),
    hour: String(now.getUTCHours()).padStart(2, '0'),
  };
}

/**
 * List raw telemetry files for the hour
 */
async function listRawTelemetry(
  year: string,
  month: string,
  day: string,
  hour: string
): Promise<string[]> {
  const prefix = `telemetry/year=${year}/month=${month}/day=${day}/hour=${hour}/`;

  const command = new ListObjectsV2Command({
    Bucket: DATA_LAKE_BUCKET,
    Prefix: prefix,
  });

  const response = await s3Client.send(command);
  return response.Contents?.map((obj: any) => obj.Key || '').filter(Boolean) || [];
}

/**
 * Parse CSV telemetry record
 * Exported for unit testing
 */
export function parseCSVRecord(csvLine: string): TelemetryRecord {
  const [device_id, temperature, humidity, pressure, timestamp, iso_timestamp] =
    csvLine.split(',');

  return {
    device_id,
    temperature: parseFloat(temperature),
    humidity: parseFloat(humidity),
    pressure: parseFloat(pressure),
    timestamp: parseInt(timestamp),
    iso_timestamp,
  };
}

/**
 * Aggregate records by 5-minute windows
 * Exported for unit testing
 */
export function aggregateRecords(records: TelemetryRecord[]): Map<string, AggregatedData> {
  const aggregated = new Map<string, AggregatedData>();
  const WINDOW_SIZE = 5 * 60 * 1000; // 5 minutes in ms

  for (const record of records) {
    // Skip outliers (temperature outside -50 to 150°C)
    if (record.temperature < -50 || record.temperature > 150) {
      console.warn('Skipping temperature outlier', {
        deviceId: record.device_id,
        temperature: record.temperature,
      });
      continue;
    }

    // Calculate window start (round down to nearest 5-minute interval)
    const windowStart = Math.floor(record.timestamp / WINDOW_SIZE) * WINDOW_SIZE;
    const windowEnd = windowStart + WINDOW_SIZE;

    const key = `${record.device_id}:${windowStart}`;

    if (!aggregated.has(key)) {
      aggregated.set(key, {
        device_id: record.device_id,
        window_start: windowStart,
        window_end: windowEnd,
        temperature_avg: 0,
        temperature_min: record.temperature,
        temperature_max: record.temperature,
        humidity_avg: 0,
        humidity_min: record.humidity,
        humidity_max: record.humidity,
        pressure_avg: 0,
        pressure_min: record.pressure,
        pressure_max: record.pressure,
        record_count: 0,
        processed_at: new Date().toISOString(),
      });
    }

    const agg = aggregated.get(key)!;
    agg.temperature_avg += record.temperature;
    agg.temperature_min = Math.min(agg.temperature_min, record.temperature);
    agg.temperature_max = Math.max(agg.temperature_max, record.temperature);
    agg.humidity_avg += record.humidity;
    agg.humidity_min = Math.min(agg.humidity_min, record.humidity);
    agg.humidity_max = Math.max(agg.humidity_max, record.humidity);
    agg.pressure_avg += record.pressure;
    agg.pressure_min = Math.min(agg.pressure_min, record.pressure);
    agg.pressure_max = Math.max(agg.pressure_max, record.pressure);
    agg.record_count++;
  }

  // Calculate averages
  for (const agg of aggregated.values()) {
    agg.temperature_avg = agg.temperature_avg / agg.record_count;
    agg.humidity_avg = agg.humidity_avg / agg.record_count;
    agg.pressure_avg = agg.pressure_avg / agg.record_count;
  }

  return aggregated;
}

/**
 * Convert aggregated data to CSV format
 */
function formatAggregatedAsCSV(aggData: AggregatedData): string {
  return [
    aggData.device_id,
    aggData.window_start,
    aggData.window_end,
    aggData.temperature_avg.toFixed(2),
    aggData.temperature_min.toFixed(2),
    aggData.temperature_max.toFixed(2),
    aggData.humidity_avg.toFixed(2),
    aggData.humidity_min.toFixed(2),
    aggData.humidity_max.toFixed(2),
    aggData.pressure_avg.toFixed(2),
    aggData.pressure_min.toFixed(2),
    aggData.pressure_max.toFixed(2),
    aggData.record_count,
    aggData.processed_at,
  ].join(',');
}

/**
 * Upload aggregated data to S3
 */
async function uploadAggregatedData(
  year: string,
  month: string,
  day: string,
  hour: string,
  aggregated: Map<string, AggregatedData>
): Promise<number> {
  let uploadCount = 0;

  for (const aggData of aggregated.values()) {
    const key = `processed/year=${year}/month=${month}/day=${day}/hour=${hour}/device-${aggData.device_id}-${aggData.window_start}.csv`;
    const csvLine = formatAggregatedAsCSV(aggData);

    const putCommand = new PutObjectCommand({
      Bucket: DATA_LAKE_BUCKET,
      Key: key,
      Body: csvLine,
      ContentType: 'text/csv',
      ServerSideEncryption: 'aws:kms',
    });

    await s3Client.send(putCommand);
    uploadCount++;
  }

  return uploadCount;
}

/**
 * Main Lambda handler
 */
export const handler = async () => {
  const startTime = Date.now();

  try {
    console.log('Processing Lambda invoked');

    // Determine hour to process
    const { year, month, day, hour } = getHourToProcess();

    console.log('Processing hour', { year, month, day, hour });

    // List raw telemetry files
    const telemetryFiles = await listRawTelemetry(year, month, day, hour);

    if (telemetryFiles.length === 0) {
      console.log('No telemetry files found for this hour');
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: 'No data to process',
          filesProcessed: 0,
        }),
      };
    }

    console.log('Found telemetry files', { count: telemetryFiles.length });

    // Read and parse telemetry records
    const records: TelemetryRecord[] = [];
    for (const fileKey of telemetryFiles) {
      try {
        const getCommand = new GetObjectCommand({
          Bucket: DATA_LAKE_BUCKET,
          Key: fileKey,
        });

        const response = await s3Client.send(getCommand);
        const body = await response.Body?.transformToString();

        if (body) {
          const record = parseCSVRecord(body);
          records.push(record);
        }
      } catch (error) {
        console.error('Failed to read telemetry file', {
          fileKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Aggregate records by 5-minute windows
    const aggregated = aggregateRecords(records);

    // Upload aggregated data
    const uploadedCount = await uploadAggregatedData(
      year,
      month,
      day,
      hour,
      aggregated
    );

    const duration = Date.now() - startTime;

    console.log('Processing complete', {
      filesProcessed: telemetryFiles.length,
      recordsProcessed: records.length,
      aggregatesCreated: aggregated.size,
      uploadsCompleted: uploadedCount,
      processingDurationMs: duration,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Processing completed successfully',
        filesProcessed: telemetryFiles.length,
        recordsProcessed: records.length,
        aggregatesCreated: aggregated.size,
        processingDurationMs: duration,
      }),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    console.error('Processing failed', {
      error: errorMessage,
      processingDurationMs: duration,
      stack: error instanceof Error ? error.stack : undefined,
    });

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Processing failed',
        message: errorMessage,
        processingDurationMs: duration,
      }),
    };
  }
};
