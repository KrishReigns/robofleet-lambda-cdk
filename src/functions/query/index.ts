/**
 * Query Lambda Handler
 *
 * Purpose: Executes SQL queries on telemetry data stored in S3 via Athena
 * Returns query results for analysis and dashboarding
 *
 * Input: Event containing:
 * - query: SQL query to execute (required)
 * - timeoutSeconds: Max time to wait for results (default: 30)
 *
 * Example query:
 * SELECT device_id, AVG(temperature) as avg_temp FROM robofleet_db.device_telemetry
 * WHERE year='2024' AND month='03' GROUP BY device_id
 *
 * Output: Query results as JSON array of rows
 *
 * Error Handling: Returns error response with Athena query execution details
 */

import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  QueryExecutionState,
} from '@aws-sdk/client-athena';

// Initialize Athena client
const athenaClient = new AthenaClient({ region: process.env.AWS_REGION });

// Environment variables
const RESULTS_BUCKET = process.env.ATHENA_RESULTS_BUCKET || 'robofleet-athena-results';
const DATABASE = process.env.GLUE_DATABASE || 'robofleet_db';
const WORKGROUP = process.env.ATHENA_WORKGROUP || 'robofleet-workgroup-v3';

/**
 * Type definitions
 */
interface QueryEvent {
  query: string;
  timeoutSeconds?: number;
  maxResults?: number;
}

/**
 * Execute Athena query and wait for results
 */
async function executeAthenaQuery(
  sqlQuery: string,
  timeoutSeconds: number = 30
): Promise<string> {
  // Start query execution
  // Note: When using a WorkGroup with EnforceWorkGroupConfiguration=true,
  // don't pass ResultConfiguration - let the workgroup's config take precedence
  const startCommand = new StartQueryExecutionCommand({
    QueryString: sqlQuery,
    QueryExecutionContext: { Database: DATABASE },
    WorkGroup: WORKGROUP,
  });

  const startResponse = await athenaClient.send(startCommand);
  const queryExecutionId = startResponse.QueryExecutionId;

  if (!queryExecutionId) {
    throw new Error('Failed to start query execution');
  }

  console.log('Query started', {
    queryExecutionId,
    database: DATABASE,
  });

  // Poll for query completion
  const maxAttempts = timeoutSeconds * 2; // Check every 500ms
  let attempts = 0;
  let queryState: QueryExecutionState = 'QUEUED';

  while (attempts < maxAttempts) {
    const getCommand = new GetQueryExecutionCommand({
      QueryExecutionId: queryExecutionId,
    });

    const response = await athenaClient.send(getCommand);
    queryState = (response.QueryExecution?.Status?.State as QueryExecutionState) || 'QUEUED';

    if (queryState === 'SUCCEEDED') {
      console.log('Query succeeded', { queryExecutionId });
      return queryExecutionId;
    }

    if (queryState === 'FAILED' || queryState === 'CANCELLED') {
      const stateChangeReason = response.QueryExecution?.Status?.StateChangeReason;
      throw new Error(
        `Query ${queryState}: ${stateChangeReason || 'Unknown error'}`
      );
    }

    // Wait 500ms before polling again
    await new Promise((resolve) => setTimeout(resolve, 500));
    attempts++;
  }

  throw new Error(`Query timeout after ${timeoutSeconds} seconds`);
}

/**
 * Fetch query results from Athena
 */
async function getQueryResults(
  queryExecutionId: string,
  maxResults: number = 1000
): Promise<any[]> {
  const getCommand = new GetQueryResultsCommand({
    QueryExecutionId: queryExecutionId,
    MaxResults: maxResults,
  });

  const response = await athenaClient.send(getCommand);
  const rows = response.ResultSet?.Rows || [];

  if (rows.length === 0) {
    return [];
  }

  // First row contains column headers
  const headers = rows[0].Data?.map((col: any) => col.VarCharValue) || [];

  // Convert remaining rows to objects
  const results = rows.slice(1).map((row: any) => {
    const obj: { [key: string]: string | undefined } = {};
    row.Data?.forEach((col: any, index: number) => {
      obj[headers[index]] = col.VarCharValue;
    });
    return obj;
  });

  return results;
}

/**
 * Main Lambda handler
 */
export const handler = async (event: QueryEvent) => {
  const startTime = Date.now();

  try {
    // Validate input
    if (!event.query) {
      throw new Error('Missing required field: query');
    }

    const sqlQuery = event.query.trim();
    const timeoutSeconds = event.timeoutSeconds || 30;
    const maxResults = event.maxResults || 1000;

    console.log('Query execution initiated', {
      query: sqlQuery.substring(0, 100), // Log first 100 chars
      database: DATABASE,
      timeoutSeconds,
    });

    // Execute query
    const queryExecutionId = await executeAthenaQuery(sqlQuery, timeoutSeconds);

    // Get results
    const results = await getQueryResults(queryExecutionId, maxResults);

    const duration = Date.now() - startTime;

    console.log('Query results retrieved', {
      queryExecutionId,
      rowCount: results.length,
      processingDurationMs: duration,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Query executed successfully',
        queryExecutionId,
        resultCount: results.length,
        results,
        processingDurationMs: duration,
      }),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    console.error('Query execution failed', {
      error: errorMessage,
      processingDurationMs: duration,
      stack: error instanceof Error ? error.stack : undefined,
    });

    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'Query execution failed',
        message: errorMessage,
        processingDurationMs: duration,
      }),
    };
  }
};
