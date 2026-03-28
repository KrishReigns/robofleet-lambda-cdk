# RoboFleet Lambda - Architecture Guide

## System Overview

RoboFleet is a real-time telemetry ingestion and analytics system on AWS using:
- Lambda — serverless compute
- S3 — data lake storage
- Glue — data catalog
- Athena — SQL queries
- SNS/SES — alerting

## Data Flow

```
Robot Device (telemetry JSON)
        ↓
Ingest Lambda → S3 Data Lake (telemetry/year=X/month=X/day=X/)
                        ↓
              Glue Table (device_telemetry)
                        ↓
              Query Lambda (SQL via Athena every 5min)
                        ↓
              Processing Lambda (aggregation every 10min)
                        ↓
              CloudWatch Alarms → SNS → Slack / Email
```

---

## Infrastructure Stacks

### Dependency Order
```
SecurityStack (no dependencies)
    ↓
    ├── NetworkingStack
    └── StorageStack
              ↓
         ComputeStack

CICDStack (independent)
```

### 1. SecurityStack
- KMS keys: `appKey` (data encryption), `auditKey` (logs)
- IAM roles: 5 Lambda execution roles + 1 Glue service role
- Secrets Manager: `robofleet/slack-webhook`, `robofleet/email-config`

### 2. NetworkingStack
- VPC: `10.0.0.0/16` across 2 AZs, private subnets only, no NAT gateway
- Gateway endpoints: S3, DynamoDB (free)
- Interface endpoints: CloudWatch Logs, SNS, Secrets Manager, Glue, Athena, KMS, CloudWatch (~$7-10/month)
- Lambda egress: locked to VPC endpoints + 3 Slack IPs only

### 3. StorageStack
- S3 data lake: `robofleet-data-lake-{account}` — KMS encrypted, versioned, 365-day expiry
- S3 Athena results: `robofleet-athena-results-{account}` — 30-day expiry
- Glue database: `robofleet_db`
- Glue table: `device_telemetry` (9 data columns + 3 partition keys)

### 4. ComputeStack
- 5 Lambda functions (Node.js 20, all inside VPC)
- SNS topic: `robofleet-alerts` → routes to Slack + Email Lambdas
- EventBridge: query every 5min, processing every 10min
- CloudWatch dashboard + 3 alarms

### 5. CICDStack
- CodeCommit repository
- CodeBuild: compile + test + `cdk synth`
- CodePipeline: Source → Build → Manual Approval → Deploy

---

## CSV Schema

**Table:** `device_telemetry`
**Database:** `robofleet_db`
**S3 Location:** `s3://robofleet-data-lake-{account}/telemetry/`
**Format:** CSV, comma-delimited, with header row

> `skip.header.line.count: 1` is set in the Glue table so Athena skips the header when querying.

### Data Columns (9)

| Column | Type | Description |
|---|---|---|
| `device_id` | string | Unique device identifier (e.g. `ROBOT-001`) |
| `fleet_id` | string | Fleet grouping (e.g. `WAREHOUSE-A`) |
| `event_time` | string | ISO 8601 timestamp |
| `battery_level` | int | Battery percentage (0-100) |
| `speed_mps` | double | Speed in meters per second |
| `status` | string | `IDLE`, `MOVING`, `CHARGING`, or `ERROR` |
| `error_code` | string | Error code if status=ERROR, empty otherwise |
| `location_zone` | string | Current zone (e.g. `ZONE-A-01`) |
| `temperature_celsius` | double | Device temperature in Celsius |

### Partition Keys (3)

| Key | Format | Example |
|---|---|---|
| `year` | YYYY | `2026` |
| `month` | MM (zero-padded) | `03` |
| `day` | DD (zero-padded) | `27` |

### Example S3 Path
```
s3://robofleet-data-lake-235695894002/telemetry/year=2026/month=03/day=27/device-ROBOT-001-1711525200000.csv
```

### Example CSV Row
```
ROBOT-001,WAREHOUSE-A,2026-03-27T14:30:45Z,85,1.5,MOVING,,ZONE-A-01,32.5
```

---

## Lambda Functions

| Function | Trigger | Timeout | Memory |
|---|---|---|---|
| `robofleet-ingest` | Direct / API | 60s | 256MB |
| `robofleet-query` | EventBridge (5min) | 120s | 512MB |
| `robofleet-processing` | EventBridge (10min) | 180s | 1024MB |
| `robofleet-sns-to-slack` | SNS | 30s | 256MB |
| `robofleet-sns-to-email` | SNS | 30s | 256MB |

### Ingest Lambda
- Receives telemetry JSON, validates required fields
- Writes CSV to S3 with KMS encryption
- Partitions by `year/month/day/hour`

### Query Lambda
- Executes SQL against `device_telemetry` via Athena workgroup `robofleet-workgroup-v3`
- Polls for completion, returns results as JSON
- Environment: `ATHENA_WORKGROUP`, `ATHENA_RESULTS_BUCKET`, `GLUE_DATABASE`

### Processing Lambda
- Reads raw CSVs from previous hour
- Aggregates into 5-minute windows (min/max/avg per device)
- Writes optimized CSVs back to `processed/` prefix in data lake

### SNS-to-Slack Lambda
- Parses CloudWatch alarm SNS message
- Fetches webhook URL from Secrets Manager (`robofleet/slack-webhook`)
- Posts formatted Block Kit message to Slack

### SNS-to-Email Lambda
- Parses CloudWatch alarm SNS message
- Fetches email config from Secrets Manager (`robofleet/email-config`)
- Sends HTML + plain text email via SES

---

## Athena Workgroup

**Workgroup:** `robofleet-workgroup-v3`
**Results:** `s3://robofleet-athena-results-{account}/query-results/`
**ExecutionRole:** `robofleet-athena-service-role`
**EnforceWorkGroupConfiguration:** true

Note: Workgroup is managed via AWS CLI (not CDK) because it was created manually before CDK adoption. ExecutionRole must be set at creation time.

---

## Sample Queries

```sql
-- Last 10 telemetry records
SELECT * FROM device_telemetry LIMIT 10;

-- Temperature stats by device
SELECT
  device_id,
  AVG(temperature_celsius) as avg_temp,
  MIN(temperature_celsius) as min_temp,
  MAX(temperature_celsius) as max_temp
FROM device_telemetry
GROUP BY device_id
ORDER BY avg_temp DESC;

-- Battery levels for a specific day
SELECT device_id, battery_level, event_time
FROM device_telemetry
WHERE year = '2026' AND month = '03' AND day = '27'
ORDER BY event_time;

-- Devices in ERROR status
SELECT device_id, error_code, event_time
FROM device_telemetry
WHERE status = 'ERROR'
  AND year = '2026' AND month = '03'
ORDER BY event_time DESC;
```

---

## Monitoring

### CloudWatch Log Groups
```
/aws/lambda/ingest
/aws/lambda/query
/aws/lambda/processing
/aws/lambda/sns-to-slack
/aws/lambda/sns-to-email
```

### CloudWatch Alarms
| Alarm | Condition | Severity |
|---|---|---|
| `robofleet-high-error-rate` | >5 ingest errors in 5min | Critical |
| `robofleet-lambda-throttling` | Any throttle event | High |
| `robofleet-slow-queries` | Avg query duration >30s | Medium |

### Dashboard
```
https://console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards:name=robofleet-metrics
```

---

## Cost Estimate

| Service | Usage | Cost/Month |
|---|---|---|
| VPC Endpoints | 7 interface endpoints | ~$7-10 |
| Lambda | 1M invocations | ~$0.20 |
| S3 Data Lake | 100GB | ~$2.30 |
| Athena | 1TB scanned | ~$6.25 |
| KMS | 2 keys | ~$1.00 |
| **Total** | | **~$50-200** |

---

## Security

- KMS customer-managed encryption on all S3 data and secrets
- Least-privilege IAM — each Lambda has its own role with only required permissions
- VPC private subnets — no internet gateway, no NAT gateway
- All AWS service calls via VPC endpoints (never leave AWS network)
- Lambda egress restricted to VPC endpoints + Slack IPs only
- S3 bucket policies deny unencrypted uploads
- Secrets Manager for all credentials (no hardcoded values)
