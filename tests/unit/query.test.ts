/**
 * Unit Tests for Query Lambda
 *
 * We test:
 * 1. handler() input validation — missing query field
 * 2. handler() success flow   — Athena starts, polls SUCCEEDED, returns results
 * 3. handler() failure flow   — Athena returns FAILED state
 * 4. handler() timeout flow   — Athena never finishes within timeoutSeconds
 */

import { handler } from '../../src/functions/query';
import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
} from '@aws-sdk/client-athena';
import { mockClient } from 'aws-sdk-client-mock';

// ============================================================
// MOCK SETUP
// ============================================================

const athenaMock = mockClient(AthenaClient);

// ============================================================
// TESTS: Input Validation
// ============================================================

describe('handler() — input validation', () => {

  beforeEach(() => {
    athenaMock.reset();
  });

  it('should return 400 when query field is missing', async () => {
    // The handler requires event.query to be present
    const result = await handler({} as any);
    expect(result.statusCode).toBe(400);
  });

  it('should include error message when query is missing', async () => {
    const result = await handler({} as any);
    const body = JSON.parse(result.body);
    expect(body.message).toContain('query');
  });

  it('should return 400 when query is an empty string', async () => {
    const result = await handler({ query: '' });
    expect(result.statusCode).toBe(400);
  });
});

// ============================================================
// TESTS: Successful query flow
// ============================================================

describe('handler() — successful query', () => {

  beforeEach(() => {
    athenaMock.reset();

    // Step 1: Mock StartQueryExecution — Athena accepts the query
    athenaMock.on(StartQueryExecutionCommand).resolves({
      QueryExecutionId: 'test-execution-id-123',
    });

    // Step 2: Mock GetQueryExecution — Athena says query SUCCEEDED
    // In real life the Lambda polls this multiple times.
    // Here we return SUCCEEDED immediately on the first poll.
    athenaMock.on(GetQueryExecutionCommand).resolves({
      QueryExecution: {
        Status: {
          State: 'SUCCEEDED',
        },
      },
    });

    // Step 3: Mock GetQueryResults — Athena returns 2 data rows
    // Row 0 = headers, Row 1+ = data
    athenaMock.on(GetQueryResultsCommand).resolves({
      ResultSet: {
        Rows: [
          // Header row
          { Data: [{ VarCharValue: 'device_id' }, { VarCharValue: 'battery_level' }] },
          // Data row 1
          { Data: [{ VarCharValue: 'ROBOT-001' }, { VarCharValue: '85' }] },
          // Data row 2
          { Data: [{ VarCharValue: 'ROBOT-002' }, { VarCharValue: '42' }] },
        ],
      },
    });
  });

  it('should return 200 on successful query', async () => {
    const result = await handler({ query: 'SELECT * FROM device_telemetry LIMIT 10' });
    expect(result.statusCode).toBe(200);
  });

  it('should include queryExecutionId in response', async () => {
    const result = await handler({ query: 'SELECT * FROM device_telemetry LIMIT 10' });
    const body = JSON.parse(result.body);
    expect(body.queryExecutionId).toBe('test-execution-id-123');
  });

  it('should return correct result count', async () => {
    const result = await handler({ query: 'SELECT * FROM device_telemetry LIMIT 10' });
    const body = JSON.parse(result.body);
    expect(body.resultCount).toBe(2);
  });

  it('should map column headers to row values correctly', async () => {
    const result = await handler({ query: 'SELECT * FROM device_telemetry LIMIT 10' });
    const body = JSON.parse(result.body);
    expect(body.results[0]).toEqual({ device_id: 'ROBOT-001', battery_level: '85' });
    expect(body.results[1]).toEqual({ device_id: 'ROBOT-002', battery_level: '42' });
  });

  it('should return empty results array when Athena returns no rows', async () => {
    athenaMock.on(GetQueryResultsCommand).resolves({
      ResultSet: { Rows: [] },
    });
    const result = await handler({ query: 'SELECT * FROM device_telemetry WHERE 1=0' });
    const body = JSON.parse(result.body);
    expect(body.results).toEqual([]);
    expect(body.resultCount).toBe(0);
  });
});

// ============================================================
// TESTS: Failed query flow
// ============================================================

describe('handler() — failed query', () => {

  beforeEach(() => {
    athenaMock.reset();

    athenaMock.on(StartQueryExecutionCommand).resolves({
      QueryExecutionId: 'failed-execution-id',
    });
  });

  it('should return 400 when Athena query FAILED', async () => {
    athenaMock.on(GetQueryExecutionCommand).resolves({
      QueryExecution: {
        Status: {
          State: 'FAILED',
          StateChangeReason: 'Table not found: device_telemetry',
        },
      },
    });
    const result = await handler({ query: 'SELECT * FROM device_telemetry' });
    expect(result.statusCode).toBe(400);
  });

  it('should include the Athena failure reason in the error message', async () => {
    athenaMock.on(GetQueryExecutionCommand).resolves({
      QueryExecution: {
        Status: {
          State: 'FAILED',
          StateChangeReason: 'Table not found: device_telemetry',
        },
      },
    });
    const result = await handler({ query: 'SELECT * FROM device_telemetry' });
    const body = JSON.parse(result.body);
    expect(body.message).toContain('Table not found');
  });

  it('should return 400 when Athena query is CANCELLED', async () => {
    athenaMock.on(GetQueryExecutionCommand).resolves({
      QueryExecution: {
        Status: { State: 'CANCELLED' },
      },
    });
    const result = await handler({ query: 'SELECT * FROM device_telemetry' });
    expect(result.statusCode).toBe(400);
  });

  it('should return 400 when StartQueryExecution returns no execution ID', async () => {
    athenaMock.on(StartQueryExecutionCommand).resolves({
      QueryExecutionId: undefined,
    });
    const result = await handler({ query: 'SELECT * FROM device_telemetry' });
    expect(result.statusCode).toBe(400);
    const body = JSON.parse(result.body);
    expect(body.message).toContain('Failed to start query execution');
  });
});

// ============================================================
// TESTS: Timeout flow
// ============================================================

describe('handler() — timeout', () => {

  beforeEach(() => {
    athenaMock.reset();

    athenaMock.on(StartQueryExecutionCommand).resolves({
      QueryExecutionId: 'timeout-execution-id',
    });

    // Always return RUNNING — query never finishes
    athenaMock.on(GetQueryExecutionCommand).resolves({
      QueryExecution: {
        Status: { State: 'RUNNING' },
      },
    });
  });

  it('should return 400 when query times out', async () => {
    // timeoutSeconds: 1 means maxAttempts = 2, each attempt waits 500ms = ~1s total
    const result = await handler({ query: 'SELECT * FROM device_telemetry', timeoutSeconds: 1 });
    expect(result.statusCode).toBe(400);
  }, 10000);

  it('should include timeout message in error', async () => {
    const result = await handler({ query: 'SELECT * FROM device_telemetry', timeoutSeconds: 1 });
    const body = JSON.parse(result.body);
    expect(body.message).toContain('timeout');
  }, 10000);
});
