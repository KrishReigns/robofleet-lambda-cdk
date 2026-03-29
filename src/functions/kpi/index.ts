/**
 * KPI Lambda — Fleet Business Metrics Publisher
 *
 * PURPOSE:
 *   Bridges the gap between raw telemetry data and CloudWatch business metrics.
 *   Runs on a schedule, queries Athena views, then publishes the results as
 *   custom CloudWatch metrics that ops teams and alarms can act on.
 *
 * WHY THIS EXISTS:
 *   CloudWatch automatically gives you Lambda errors and duration (system health).
 *   But your stakeholders care about BUSINESS health:
 *     - How many robots are in error state RIGHT NOW?
 *     - What is the fleet-wide average battery level?
 *     - How many devices have critically low battery (need charging)?
 *   Those questions can only be answered by querying your telemetry data.
 *   This Lambda bridges that gap by publishing Athena results as CloudWatch metrics.
 *
 * HOW IT WORKS (the full data flow):
 *   EventBridge (every 5 min)
 *     → KPI Lambda
 *       → Athena query on robofleet_db.device_status_summary (the view we created)
 *         → Compute KPIs from results
 *           → CloudWatch.putMetricData() → namespace "RoboFleet/Fleet"
 *             → CloudWatch Alarms watch these metrics
 *               → Alarm triggers SNS → Slack/Email alert
 *
 * METRICS PUBLISHED (namespace: RoboFleet/Fleet):
 *   ActiveDeviceCount     - Total devices that reported in the last hour
 *   ErrorDeviceCount      - Devices currently in ERROR status
 *   CriticalBatteryCount  - Devices with battery < 20%
 *   FleetErrorRatePct     - % of events that were errors (your fleet SLI)
 *   AvgBatteryLevel       - Fleet-wide average battery percentage
 *   AvgTemperatureCelsius - Fleet-wide average temperature
 *
 * DIMENSIONS:
 *   CloudWatch dimensions are like SQL GROUP BY — they let you filter metrics.
 *   We use { Name: "Fleet", Value: "ALL" } for fleet-wide aggregates.
 *   In a more advanced setup you'd publish per-fleet (e.g. { Fleet: "FLEET-BOSTON-01" }).
 */

import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
} from '@aws-sdk/client-athena';
import {
  CloudWatchClient,
  PutMetricDataCommand,
  MetricDatum,
  StandardUnit,
} from '@aws-sdk/client-cloudwatch';

const athena = new AthenaClient({ region: process.env.AWS_REGION });
const cloudwatch = new CloudWatchClient({ region: process.env.AWS_REGION });

const WORKGROUP  = process.env.ATHENA_WORKGROUP  || 'robofleet-workgroup-v3';
const DATABASE   = process.env.GLUE_DATABASE     || 'robofleet_db';
// Namespace is the "folder" in CloudWatch — keep it consistent across Lambdas
const NAMESPACE  = 'RoboFleet/Fleet';

// ─── Athena helpers ────────────────────────────────────────────────────────────

/**
 * Run an Athena query and wait for it to finish (polls every 2s, max 60s).
 * Returns the query execution ID so we can fetch results separately.
 *
 * KEY CONCEPT — why poll?
 *   Athena is async: you submit a query and get an ID back immediately.
 *   The actual execution happens in the background (could take 1–30 seconds).
 *   You must poll GetQueryExecution until state = SUCCEEDED | FAILED.
 */
async function runQuery(sql: string): Promise<string> {
  const { QueryExecutionId } = await athena.send(new StartQueryExecutionCommand({
    QueryString: sql,
    QueryExecutionContext: { Database: DATABASE },
    WorkGroup: WORKGROUP,
  }));

  if (!QueryExecutionId) throw new Error('Athena did not return a QueryExecutionId');

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const { QueryExecution } = await athena.send(
      new GetQueryExecutionCommand({ QueryExecutionId })
    );
    const state = QueryExecution?.Status?.State;
    if (state === 'SUCCEEDED') return QueryExecutionId;
    if (state === 'FAILED' || state === 'CANCELLED') {
      throw new Error(`Query ${state}: ${QueryExecution?.Status?.StateChangeReason}`);
    }
  }
  throw new Error('Athena query timed out after 60 seconds');
}

/**
 * Fetch rows from a completed Athena query.
 * Returns array of objects (column name → value).
 *
 * KEY CONCEPT — result format:
 *   Athena returns rows as arrays of { VarCharValue: string }.
 *   Row 0 is always the header row (column names).
 *   We zip headers + values into plain objects for easy access.
 */
async function fetchRows(executionId: string): Promise<Record<string, string>[]> {
  const { ResultSet } = await athena.send(
    new GetQueryResultsCommand({ QueryExecutionId: executionId })
  );
  const rows = ResultSet?.Rows ?? [];
  if (rows.length < 2) return [];
  const headers = rows[0].Data?.map(d => d.VarCharValue ?? '') ?? [];
  return rows.slice(1).map(row => {
    const obj: Record<string, string> = {};
    row.Data?.forEach((cell, i) => { obj[headers[i]] = cell.VarCharValue ?? '0'; });
    return obj;
  });
}

// ─── KPI computation ───────────────────────────────────────────────────────────

/**
 * Build the SQL for today's fleet KPIs.
 *
 * KEY CONCEPT — why filter today's date?
 *   The device_status_summary VIEW still has year/month/day partition columns.
 *   Without this filter, Athena would scan ALL historical data = expensive + slow.
 *   Always push partition filters down as far as possible.
 */
function buildKpiSql(): string {
  const now = new Date();
  const year  = now.getUTCFullYear().toString();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day   = String(now.getUTCDate()).padStart(2, '0');

  // We query the VIEW (device_status_summary), not the raw table.
  // The view already has session_count, error_count, avg_battery_pct pre-computed.
  return `
    SELECT
      COUNT(DISTINCT device_id)                                         AS active_device_count,
      SUM(error_count)                                                  AS total_error_events,
      COUNT(DISTINCT device_id) FILTER (WHERE error_count > 0)         AS error_device_count,
      COUNT(DISTINCT device_id) FILTER (WHERE min_battery_pct < 20)    AS critical_battery_count,
      ROUND(AVG(avg_battery_pct), 1)                                   AS fleet_avg_battery,
      ROUND(AVG(avg_temp_celsius), 1)                                  AS fleet_avg_temp,
      ROUND(
        SUM(error_count) * 100.0 / NULLIF(SUM(session_count), 0),
      2)                                                                AS fleet_error_rate_pct
    FROM robofleet_db.device_status_summary
    WHERE year = '${year}'
      AND month = '${month}'
      AND day   = '${day}'
  `;
}

/**
 * Publish all KPI metrics to CloudWatch in a single batch call.
 *
 * KEY CONCEPT — PutMetricData batching:
 *   CloudWatch charges per metric PUT. Batching up to 20 metrics per call
 *   reduces API calls and keeps costs low.
 *   Each MetricDatum has: MetricName, Value, Unit, Dimensions, Timestamp.
 *
 * KEY CONCEPT — Dimensions:
 *   Dimensions are like tags. { Name: "Fleet", Value: "ALL" } means
 *   "this is a fleet-wide aggregate". Later you could add per-fleet dimensions
 *   by looping fleet results and publishing { Fleet: "FLEET-BOSTON-01" }.
 */
async function publishMetrics(kpis: Record<string, string>): Promise<void> {
  const now = new Date();

  const dimensions = [{ Name: 'Fleet', Value: 'ALL' }];

  const metrics: MetricDatum[] = [
    {
      MetricName: 'ActiveDeviceCount',
      Value: parseFloat(kpis.active_device_count ?? '0'),
      Unit: StandardUnit.Count,
      Dimensions: dimensions,
      Timestamp: now,
    },
    {
      MetricName: 'ErrorDeviceCount',
      Value: parseFloat(kpis.error_device_count ?? '0'),
      Unit: StandardUnit.Count,
      Dimensions: dimensions,
      Timestamp: now,
    },
    {
      MetricName: 'CriticalBatteryCount',
      Value: parseFloat(kpis.critical_battery_count ?? '0'),
      Unit: StandardUnit.Count,
      Dimensions: dimensions,
      Timestamp: now,
    },
    {
      MetricName: 'FleetErrorRatePct',
      Value: parseFloat(kpis.fleet_error_rate_pct ?? '0'),
      Unit: StandardUnit.Percent,
      Dimensions: dimensions,
      Timestamp: now,
    },
    {
      MetricName: 'AvgBatteryLevel',
      Value: parseFloat(kpis.fleet_avg_battery ?? '0'),
      Unit: StandardUnit.Percent,
      Dimensions: dimensions,
      Timestamp: now,
    },
    {
      MetricName: 'AvgTemperatureCelsius',
      Value: parseFloat(kpis.fleet_avg_temp ?? '0'),
      Unit: StandardUnit.None,
      Dimensions: dimensions,
      Timestamp: now,
    },
  ];

  await cloudwatch.send(new PutMetricDataCommand({
    Namespace: NAMESPACE,
    MetricData: metrics,
  }));

  console.log('KPI metrics published', {
    namespace: NAMESPACE,
    metrics: metrics.map(m => `${m.MetricName}=${m.Value}`),
  });
}

// ─── Lambda handler ────────────────────────────────────────────────────────────

export const handler = async (_event: unknown) => {
  const start = Date.now();
  try {
    console.log('KPI Lambda started', { timestamp: new Date().toISOString() });

    const sql        = buildKpiSql();
    const execId     = await runQuery(sql);
    const rows       = await fetchRows(execId);

    if (rows.length === 0) {
      console.warn('No KPI data returned — no telemetry for today yet');
      // Publish zeros so alarms don't go stale (missing data can be misleading)
      await publishMetrics({});
    } else {
      await publishMetrics(rows[0]);
      console.log('KPI row', rows[0]);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'KPI metrics published',
        durationMs: Date.now() - start,
      }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('KPI Lambda failed', { error: msg, durationMs: Date.now() - start });
    return { statusCode: 500, body: JSON.stringify({ error: msg }) };
  }
};
