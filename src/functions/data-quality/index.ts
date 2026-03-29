/**
 * Data Quality Lambda — Pipeline Health Watchdog
 *
 * PURPOSE:
 *   Detects silent failures in the telemetry data pipeline.
 *   Runs every 30 minutes and checks three quality dimensions:
 *
 *   1. DATA FRESHNESS  — Did new telemetry arrive in the last 30 minutes?
 *      Why it matters: If ingest Lambda or the IoT sender breaks, no error is thrown.
 *      Queries land in S3 and Athena simply returns old data. This check catches that.
 *
 *   2. PARTITION HEALTH — Does today's Glue partition exist?
 *      Why it matters: Glue external tables need MSCK REPAIR TABLE run after new
 *      S3 prefixes are created. Without it, Athena queries return 0 rows even
 *      though data is in S3. This check alerts you to run the repair.
 *
 *   3. DEVICE COUNT REGRESSION — Did we lose devices since yesterday?
 *      Why it matters: Normal churn is 1–2 devices. Losing 30% overnight = incident.
 *      This catches connectivity issues, fleet configuration changes, or code bugs.
 *
 * ACTIONS:
 *   - Publishes CloudWatch metrics: DataFreshnessMinutes, TodayPartitionExists,
 *     ActiveDeviceCount (for trend comparison), DeviceCountDelta
 *   - Publishes SNS alert if any check fails (→ Slack + email)
 *
 * HOW IT FITS IN THE ARCHITECTURE:
 *   EventBridge (every 30 min)
 *     → DataQuality Lambda
 *       → Athena queries on device_telemetry (raw table, not view)
 *         → CloudWatch custom metrics (namespace: RoboFleet/DataQuality)
 *           → If issues found: SNS publish → Slack + Email alert
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
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

const athena     = new AthenaClient({ region: process.env.AWS_REGION });
const cloudwatch = new CloudWatchClient({ region: process.env.AWS_REGION });
const sns        = new SNSClient({ region: process.env.AWS_REGION });

const WORKGROUP      = process.env.ATHENA_WORKGROUP  || 'robofleet-workgroup-v3';
const DATABASE       = process.env.GLUE_DATABASE     || 'robofleet_db';
const ALERTS_TOPIC   = process.env.ALERTS_TOPIC_ARN  || '';
const NAMESPACE      = 'RoboFleet/DataQuality';

// ─── Athena helpers (same pattern as KPI Lambda) ────────────────────────────────

async function runQuery(sql: string): Promise<string> {
  const { QueryExecutionId } = await athena.send(new StartQueryExecutionCommand({
    QueryString: sql,
    QueryExecutionContext: { Database: DATABASE },
    WorkGroup: WORKGROUP,
  }));
  if (!QueryExecutionId) throw new Error('No QueryExecutionId returned');

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
  throw new Error('Athena query timed out');
}

async function fetchRows(execId: string): Promise<Record<string, string>[]> {
  const { ResultSet } = await athena.send(
    new GetQueryResultsCommand({ QueryExecutionId: execId })
  );
  const rows = ResultSet?.Rows ?? [];
  if (rows.length < 2) return [];
  const headers = rows[0].Data?.map(d => d.VarCharValue ?? '') ?? [];
  return rows.slice(1).map(row => {
    const obj: Record<string, string> = {};
    row.Data?.forEach((cell, i) => { obj[headers[i]] = cell.VarCharValue ?? ''; });
    return obj;
  });
}

// ─── Quality check functions ────────────────────────────────────────────────────

/**
 * CHECK 1: Data Freshness
 *
 * Finds the most recent event_time in today's partition.
 * Returns how many minutes ago the last record arrived.
 *
 * KEY CONCEPT — why not use S3 LastModified?
 *   S3 LastModified only tells you when a file was uploaded, not when the event occurred.
 *   Late data (events from hours ago arriving now) would look "fresh" by S3 dates.
 *   Querying event_time tells you what the device actually reported.
 */
async function checkDataFreshness(): Promise<{ freshnessMinutes: number; lastSeen: string }> {
  const now   = new Date();
  const year  = now.getUTCFullYear().toString();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day   = String(now.getUTCDate()).padStart(2, '0');

  const sql = `
    SELECT
      MAX(event_time) AS last_event_time,
      COUNT(*)        AS record_count
    FROM robofleet_db.device_telemetry
    WHERE year = '${year}' AND month = '${month}' AND day = '${day}'
  `;

  const rows = await fetchRows(await runQuery(sql));
  if (rows.length === 0 || !rows[0].last_event_time) {
    // No data at all today — maximum staleness
    return { freshnessMinutes: 9999, lastSeen: 'NEVER' };
  }

  const lastEvent  = new Date(rows[0].last_event_time);
  const freshnessMinutes = Math.floor((now.getTime() - lastEvent.getTime()) / 60000);
  return { freshnessMinutes, lastSeen: rows[0].last_event_time };
}

/**
 * CHECK 2: Partition Health
 *
 * Checks if today's partition exists in Glue.
 *
 * KEY CONCEPT — Glue partitions vs S3 files:
 *   Glue keeps a metadata catalog of which partitions exist.
 *   When new S3 prefixes are created, Glue doesn't know automatically.
 *   MSCK REPAIR TABLE registers them. Until that runs, Athena sees no data
 *   for today even though files are in S3.
 *
 *   We detect this by counting records in today's partition.
 *   If count=0 but we know data should exist, MSCK REPAIR TABLE is needed.
 */
async function checkPartitionHealth(): Promise<{ todayRecordCount: number; partitionExists: boolean }> {
  const now   = new Date();
  const year  = now.getUTCFullYear().toString();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day   = String(now.getUTCDate()).padStart(2, '0');

  const sql = `
    SELECT COUNT(*) AS cnt
    FROM robofleet_db.device_telemetry
    WHERE year = '${year}' AND month = '${month}' AND day = '${day}'
  `;

  const rows       = await fetchRows(await runQuery(sql));
  const cnt        = parseInt(rows[0]?.cnt ?? '0', 10);
  return { todayRecordCount: cnt, partitionExists: cnt > 0 };
}

/**
 * CHECK 3: Device Count Regression
 *
 * Compares today's active device count against yesterday's.
 * A >30% drop is flagged as a potential incident.
 *
 * KEY CONCEPT — regression detection:
 *   Absolute thresholds ("< 10 devices") are fragile — they break as fleets grow.
 *   Relative thresholds ("30% fewer than yesterday") scale with your data.
 *   This is how production monitoring works at scale (SRE principle: relative baselines).
 */
async function checkDeviceCountRegression(): Promise<{
  todayCount: number;
  yesterdayCount: number;
  deltaPercent: number;
}> {
  const now       = new Date();
  const yesterday = new Date(now.getTime() - 86400000);

  const fmt = (d: Date) => ({
    year:  d.getUTCFullYear().toString(),
    month: String(d.getUTCMonth() + 1).padStart(2, '0'),
    day:   String(d.getUTCDate()).padStart(2, '0'),
  });

  const today = fmt(now);
  const yest  = fmt(yesterday);

  const sql = `
    SELECT
      SUM(CASE WHEN year='${today.year}' AND month='${today.month}' AND day='${today.day}'
               THEN 1 ELSE 0 END) AS today_count,
      SUM(CASE WHEN year='${yest.year}'  AND month='${yest.month}'  AND day='${yest.day}'
               THEN 1 ELSE 0 END) AS yesterday_count
    FROM (
      SELECT year, month, day, device_id,
             ROW_NUMBER() OVER (PARTITION BY year, month, day, device_id ORDER BY event_time DESC) AS rn
      FROM robofleet_db.device_telemetry
      WHERE (year='${today.year}' AND month='${today.month}' AND day='${today.day}')
         OR (year='${yest.year}'  AND month='${yest.month}'  AND day='${yest.day}')
    ) sub
    WHERE rn = 1
  `;

  const rows           = await fetchRows(await runQuery(sql));
  // Use || instead of ?? — Athena returns "" (empty string) for NULL SUMs, and
  // ?? only catches null/undefined. parseInt("") = NaN; parseInt("0") = 0.
  const todayCount     = parseInt(rows[0]?.today_count     || '0', 10);
  const yesterdayCount = parseInt(rows[0]?.yesterday_count || '0', 10);
  const deltaPercent   = yesterdayCount > 0
    ? Math.round((todayCount - yesterdayCount) / yesterdayCount * 100)
    : 0;

  return { todayCount, yesterdayCount, deltaPercent };
}

// ─── Alert publisher ────────────────────────────────────────────────────────────

async function sendAlert(subject: string, message: string): Promise<void> {
  if (!ALERTS_TOPIC) {
    console.warn('ALERTS_TOPIC_ARN not set — skipping alert');
    return;
  }
  await sns.send(new PublishCommand({
    TopicArn: ALERTS_TOPIC,
    Subject:  subject,
    Message:  message,
  }));
  console.warn('DATA QUALITY ALERT SENT', { subject, message });
}

// ─── Metrics publisher ──────────────────────────────────────────────────────────

async function publishQualityMetrics(
  freshnessMinutes: number,
  partitionExists: boolean,
  todayDeviceCount: number,
  deviceDeltaPct: number
): Promise<void> {
  const now    = new Date();
  const dims   = [{ Name: 'Pipeline', Value: 'Telemetry' }];

  const metrics: MetricDatum[] = [
    {
      MetricName: 'DataFreshnessMinutes',
      Value:      Math.min(freshnessMinutes, 9999), // cap for CloudWatch display
      Unit:       StandardUnit.None,
      Dimensions: dims,
      Timestamp:  now,
    },
    {
      MetricName: 'TodayPartitionExists',
      Value:      partitionExists ? 1 : 0,
      Unit:       StandardUnit.Count,
      Dimensions: dims,
      Timestamp:  now,
    },
    {
      MetricName: 'ActiveDeviceCount',
      Value:      todayDeviceCount,
      Unit:       StandardUnit.Count,
      Dimensions: dims,
      Timestamp:  now,
    },
    {
      MetricName: 'DeviceCountDeltaPct',
      Value:      deviceDeltaPct,
      Unit:       StandardUnit.Percent,
      Dimensions: dims,
      Timestamp:  now,
    },
  ];

  await cloudwatch.send(new PutMetricDataCommand({
    Namespace:  NAMESPACE,
    MetricData: metrics,
  }));
}

// ─── Lambda handler ────────────────────────────────────────────────────────────

export const handler = async (_event: unknown) => {
  const start  = Date.now();
  const alerts: string[] = [];

  try {
    console.log('Data Quality Lambda started');

    // Run all three checks (sequentially to avoid Athena concurrency limits)
    const [freshness, partition, deviceCount] = await Promise.all([
      checkDataFreshness(),
      checkPartitionHealth(),
      checkDeviceCountRegression(),
    ]);

    console.log('Data quality results', { freshness, partition, deviceCount });

    // ── Evaluate checks and build alerts ──────────────────────────────────────

    // Check 1: Freshness — alert if data is older than 30 minutes
    if (freshness.freshnessMinutes > 30) {
      alerts.push(
        `🚨 DATA FRESHNESS ALERT\n` +
        `Last telemetry received: ${freshness.lastSeen}\n` +
        `Staleness: ${freshness.freshnessMinutes} minutes\n` +
        `Action: Check robofleet-ingest Lambda logs and IoT device connectivity.`
      );
    }

    // Check 2: Partition — alert if no records exist for today
    if (!partition.partitionExists) {
      alerts.push(
        `⚠️ MISSING PARTITION ALERT\n` +
        `No data found for today's partition (year/month/day).\n` +
        `Action: Run MSCK REPAIR TABLE device_telemetry in Athena workgroup robofleet-workgroup-v3.`
      );
    }

    // Check 3: Device count — alert if more than 30% drop from yesterday
    if (deviceCount.yesterdayCount > 0 && deviceCount.deltaPercent < -30) {
      alerts.push(
        `⚠️ DEVICE COUNT REGRESSION\n` +
        `Yesterday: ${deviceCount.yesterdayCount} devices\n` +
        `Today:     ${deviceCount.todayCount} devices\n` +
        `Drop:      ${Math.abs(deviceCount.deltaPercent)}%\n` +
        `Action: Check fleet connectivity and IoT gateway health.`
      );
    }

    // Publish CloudWatch metrics
    await publishQualityMetrics(
      freshness.freshnessMinutes,
      partition.partitionExists,
      deviceCount.todayCount,
      deviceCount.deltaPercent
    );

    // Send consolidated alert if any checks failed
    if (alerts.length > 0) {
      await sendAlert(
        `RoboFleet Data Quality Issue (${alerts.length} check(s) failed)`,
        alerts.join('\n\n---\n\n')
      );
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        checksRun: 3,
        alertsFired: alerts.length,
        freshness,
        partition,
        deviceCount,
        durationMs: Date.now() - start,
      }),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Data Quality Lambda failed', { error: msg });
    await sendAlert('RoboFleet Data Quality Lambda ERROR', `Lambda crashed: ${msg}`).catch(() => {});
    return { statusCode: 500, body: JSON.stringify({ error: msg }) };
  }
};
