/**
 * Unit Tests for Processing Lambda
 *
 * We test:
 * 1. getHourToProcess()  — returns the previous hour (pure, no AWS)
 * 2. parseCSVRecord()    — parses a CSV line into a typed object (pure, no AWS)
 * 3. aggregateRecords()  — groups records into 5-min windows (pure, no AWS)
 * 4. handler()           — full flow with mocked S3
 */

import {
  getHourToProcess,
  parseCSVRecord,
  aggregateRecords,
  handler,
  TelemetryRecord,
} from '../../src/functions/processing';

import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';

// ============================================================
// MOCK SETUP
// ============================================================

const s3Mock = mockClient(S3Client);

// ============================================================
// TESTS: getHourToProcess()
// ============================================================

describe('getHourToProcess()', () => {

  it('should return an object with year, month, day, hour', () => {
    const result = getHourToProcess();
    // Check all 4 keys exist
    expect(result).toHaveProperty('year');
    expect(result).toHaveProperty('month');
    expect(result).toHaveProperty('day');
    expect(result).toHaveProperty('hour');
  });

  it('should return zero-padded month', () => {
    // Month should always be 2 digits e.g. "03" not "3"
    const result = getHourToProcess();
    expect(result.month).toMatch(/^\d{2}$/);
  });

  it('should return zero-padded day', () => {
    const result = getHourToProcess();
    expect(result.day).toMatch(/^\d{2}$/);
  });

  it('should return zero-padded hour', () => {
    const result = getHourToProcess();
    expect(result.hour).toMatch(/^\d{2}$/);
  });

  it('should return the previous hour, not the current hour', () => {
    // The processing Lambda always processes the PREVIOUS hour's data
    // so it's never processing data that's still being written
    const now = new Date();
    const expectedHour = new Date(now.getTime() - 60 * 60 * 1000);
    const result = getHourToProcess();

    expect(result.hour).toBe(String(expectedHour.getUTCHours()).padStart(2, '0'));
  });
});

// ============================================================
// TESTS: parseCSVRecord()
// ============================================================

describe('parseCSVRecord()', () => {

  // A sample CSV line matching the old processing format:
  // device_id, temperature, humidity, pressure, timestamp, iso_timestamp
  const sampleCSV = 'ROBOT-001,25.5,60.0,1013.25,1711525200000,2024-03-27T14:00:00.000Z';

  it('should parse device_id correctly', () => {
    const record = parseCSVRecord(sampleCSV);
    expect(record.device_id).toBe('ROBOT-001');
  });

  it('should parse temperature as a number', () => {
    const record = parseCSVRecord(sampleCSV);
    // parseFloat converts "25.5" string → 25.5 number
    expect(record.temperature).toBe(25.5);
    expect(typeof record.temperature).toBe('number');
  });

  it('should parse humidity as a number', () => {
    const record = parseCSVRecord(sampleCSV);
    expect(record.humidity).toBe(60.0);
    expect(typeof record.humidity).toBe('number');
  });

  it('should parse pressure as a number', () => {
    const record = parseCSVRecord(sampleCSV);
    expect(record.pressure).toBe(1013.25);
    expect(typeof record.pressure).toBe('number');
  });

  it('should parse timestamp as an integer', () => {
    const record = parseCSVRecord(sampleCSV);
    expect(record.timestamp).toBe(1711525200000);
    expect(typeof record.timestamp).toBe('number');
  });

  it('should parse iso_timestamp as a string', () => {
    const record = parseCSVRecord(sampleCSV);
    expect(record.iso_timestamp).toBe('2024-03-27T14:00:00.000Z');
  });
});

// ============================================================
// TESTS: aggregateRecords()
// ============================================================

describe('aggregateRecords()', () => {

  // Helper to create a telemetry record at a specific timestamp
  const makeRecord = (deviceId: string, temp: number, timestampMs: number): TelemetryRecord => ({
    device_id: deviceId,
    temperature: temp,
    humidity: 60,
    pressure: 1013,
    timestamp: timestampMs,
    iso_timestamp: new Date(timestampMs).toISOString(),
  });

  // Two records for the same device in the same 5-minute window
  // Window = floor(timestamp / 5min) * 5min
  const baseTime = 1711525200000; // 2024-03-27T14:00:00Z (on a 5-min boundary)
  const record1 = makeRecord('ROBOT-001', 20, baseTime);
  const record2 = makeRecord('ROBOT-001', 30, baseTime + 60000); // 1 min later, same window

  it('should return an empty Map for empty input', () => {
    const result = aggregateRecords([]);
    expect(result.size).toBe(0);
  });

  it('should group records from the same device and window into one entry', () => {
    const result = aggregateRecords([record1, record2]);
    // Both records are in the same 5-min window for ROBOT-001
    expect(result.size).toBe(1);
  });

  it('should calculate correct average temperature', () => {
    const result = aggregateRecords([record1, record2]);
    const agg = Array.from(result.values())[0];
    // avg of 20 and 30 = 25
    expect(agg.temperature_avg).toBe(25);
  });

  it('should calculate correct min temperature', () => {
    const result = aggregateRecords([record1, record2]);
    const agg = Array.from(result.values())[0];
    expect(agg.temperature_min).toBe(20);
  });

  it('should calculate correct max temperature', () => {
    const result = aggregateRecords([record1, record2]);
    const agg = Array.from(result.values())[0];
    expect(agg.temperature_max).toBe(30);
  });

  it('should count records correctly', () => {
    const result = aggregateRecords([record1, record2]);
    const agg = Array.from(result.values())[0];
    expect(agg.record_count).toBe(2);
  });

  it('should create separate entries for different devices', () => {
    const robot2 = makeRecord('ROBOT-002', 25, baseTime);
    const result = aggregateRecords([record1, robot2]);
    // Two different devices = two separate aggregation entries
    expect(result.size).toBe(2);
  });

  it('should create separate entries for different time windows', () => {
    // 6 minutes later = different 5-min window
    const laterRecord = makeRecord('ROBOT-001', 25, baseTime + 6 * 60 * 1000);
    const result = aggregateRecords([record1, laterRecord]);
    expect(result.size).toBe(2);
  });

  it('should skip temperature outliers above 150°C', () => {
    const outlier = makeRecord('ROBOT-001', 200, baseTime); // 200°C is an outlier
    const result = aggregateRecords([outlier]);
    // Outlier should be skipped, result should be empty
    expect(result.size).toBe(0);
  });

  it('should skip temperature outliers below -50°C', () => {
    const outlier = makeRecord('ROBOT-001', -100, baseTime); // -100°C is an outlier
    const result = aggregateRecords([outlier]);
    expect(result.size).toBe(0);
  });

  it('should accept temperatures at the boundary values', () => {
    const atMax = makeRecord('ROBOT-001', 150, baseTime);  // exactly 150 is valid
    const atMin = makeRecord('ROBOT-002', -50, baseTime);  // exactly -50 is valid
    const result = aggregateRecords([atMax, atMin]);
    expect(result.size).toBe(2);
  });
});

// ============================================================
// TESTS: handler()
// ============================================================

describe('handler()', () => {

  beforeEach(() => {
    s3Mock.reset();
  });

  it('should return 200 with "No data to process" when no files found', async () => {
    // Mock S3 ListObjects to return empty list
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });

    const result = await handler();
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.message).toBe('No data to process');
    expect(body.filesProcessed).toBe(0);
  });

  it('should return 200 and process files when they exist', async () => {
    // Mock S3 to return one file
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: 'telemetry/year=2026/month=03/day=29/hour=10/device-ROBOT-001-123.csv' }],
    });

    // Mock S3 GetObject to return a CSV record
    s3Mock.on(GetObjectCommand).resolves({
      Body: {
        transformToString: async () => 'ROBOT-001,25.5,60.0,1013.25,1711525200000,2024-03-27T14:00:00.000Z',
      } as any,
    });

    // Mock S3 PutObject for the aggregated output
    s3Mock.on(PutObjectCommand).resolves({ ETag: 'test-etag' });

    const result = await handler();
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.filesProcessed).toBe(1);
    expect(body.recordsProcessed).toBe(1);
  });

  it('should return 200 even when S3 GetObject fails for a file', async () => {
    // One file listed but reading it fails
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: 'telemetry/year=2026/month=03/day=29/hour=10/bad-file.csv' }],
    });
    s3Mock.on(GetObjectCommand).rejects(new Error('S3 read error'));
    s3Mock.on(PutObjectCommand).resolves({});

    // Should not crash — just skip the bad file and continue
    const result = await handler();
    expect(result.statusCode).toBe(200);
  });
});
