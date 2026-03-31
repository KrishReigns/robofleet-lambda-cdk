# RoboFleet Lambda CDK — Serverless Fleet Telemetry Analytics

Real-time device telemetry ingestion, analytics, and BI dashboards on AWS for autonomous robot fleets. Built with TypeScript and AWS CDK.

**Stack:** AWS CDK · TypeScript · Lambda · S3 · Glue · Athena · CloudWatch · SNS/SES · QuickSight · KMS

---

## Architecture

![RoboFleet Architecture](docs/architecture-visual.drawio.png)

> To edit the diagram, open [diagrams.net](https://app.diagrams.net) and import `docs/architecture-visual.drawio`.

---

## Infrastructure — 4 Active CDK Stacks

```
SecurityStack → StorageStack → ComputeStack → CICDStack
```

| Stack | What it creates |
|---|---|
| **SecurityStack** | 2 KMS keys, 9 IAM roles (1 per Lambda + Glue), Secrets Manager |
| **StorageStack** | S3 data lake + Athena results bucket, Glue database + table |
| **ComputeStack** | 7 Lambda functions, SNS topic, 6 CloudWatch alarms, EventBridge rules, dashboard |
| **CICDStack** | CodeCommit → CodeBuild → CodePipeline (with manual approval gate) |
| **QuickSightStack** _(optional)_ | Athena DataSource, 2 QuickSight DataSets, IAM grants — requires manual QuickSight activation first |

> **NetworkingStack removed** — VPC + 7 interface endpoints cost ~$50/month with no benefit for a personal project. Lambdas reach AWS services via public endpoints (TLS encrypted in transit).

---

## Lambda Functions — 7 Total

| Function | Trigger | Purpose |
|---|---|---|
| `robofleet-ingest` | Direct invoke | Receives telemetry JSON → writes CSV to S3 |
| `robofleet-query` | EventBridge 5 min | Ad-hoc Athena SQL queries on demand |
| `robofleet-processing` | EventBridge 10 min | Aggregates raw telemetry, optimises for Athena |
| `robofleet-sns-to-slack` | SNS | Formats and routes alerts to Slack via webhook |
| `robofleet-sns-to-email` | SNS | Formats and routes alerts via SES |
| `robofleet-kpi` | EventBridge 5 min | Queries `device_status_summary`, publishes 6 business metrics to CloudWatch |
| `robofleet-data-quality` | EventBridge 30 min | Watchdog — 3 pipeline health checks, fires SNS on failure |

---

## CloudWatch Alarms — 6 Total

| Alarm | Metric | Threshold | Namespace |
|---|---|---|---|
| `robofleet-critical-battery-count` | CriticalBatteryCount | > 3 devices | RoboFleet/Fleet |
| `robofleet-fleet-error-rate` | FleetErrorRatePct | > 25% for 2 periods | RoboFleet/Fleet |
| `robofleet-data-freshness` | DataFreshnessMinutes | > 60 min | RoboFleet/DataQuality |
| `robofleet-high-error-rate` | Lambda Errors | > 5 in 5 min | AWS/Lambda |
| `robofleet-lambda-throttling` | Lambda Throttles | Any throttle | AWS/Lambda |
| `robofleet-slow-queries` | Query Duration | Avg > 30s | AWS/Lambda |

---

## Project Structure

```
robofleet-lambda-cdk/
├── bin/
│   └── app.ts                        # CDK app — wires all stacks
├── lib/stacks/
│   ├── security-stack.ts             # KMS, 9 IAM roles, Secrets Manager
│   ├── storage-stack.ts              # S3, Glue database/table, Athena workgroup
│   ├── compute-stack.ts              # 7 Lambdas, SNS, CloudWatch, EventBridge
│   ├── quicksight-stack.ts           # (optional) Athena DataSource + 2 DataSets
│   └── cicd-stack.ts                 # CodeCommit, CodeBuild, CodePipeline
├── src/functions/
│   ├── ingest/index.ts               # Telemetry ingest → S3
│   ├── query/index.ts                # Athena SQL on demand
│   ├── processing/index.ts           # Aggregation + optimisation
│   ├── sns-to-slack/index.ts         # Slack alert routing
│   ├── sns-to-email/index.ts         # Email alert routing
│   ├── kpi/index.ts                  # Business KPI metrics → CloudWatch
│   └── data-quality/index.ts         # Pipeline health watchdog
├── scripts/
│   ├── athena-views.sql              # SQL for fleet_daily_health, device_status_summary, zone_activity
│   ├── setup-athena-views.sh         # CLI script to create Athena views
│   ├── verify-deployment.sh          # Post-deploy smoke tests
│   └── test_lambda_query.py          # Athena query test harness
├── tests/unit/                       # Jest unit tests (80 passing)
├── data-seed/                        # Sample telemetry CSV files (3 days)
├── docs/
│   ├── architecture-visual.drawio    # Visual diagram (open in diagrams.net)
│   ├── ARCHITECTURE.md               # Deep-dive architecture reference
│   ├── DEPLOYMENT.md                 # Step-by-step deployment guide
│   ├── TROUBLESHOOTING.md            # Common issues and fixes
│   └── LAMBDA_TESTING.md             # Lambda invocation and verification
└── cdk.json                          # CDK config
```

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Build TypeScript
npm run build

# 3. Deploy core stacks
npx cdk deploy RobofleetSecurityStack RobofleetStorageStack RobofleetComputeStack RobofleetCICDStack \
  --region us-east-1 --require-approval never

# 4. Create Athena views (required for KPI Lambda)
./scripts/setup-athena-views.sh

# 5. Upload sample data and register partitions
aws s3 sync data-seed/ s3://robofleet-data-lake-{account}/telemetry/
aws athena start-query-execution \
  --query-string "MSCK REPAIR TABLE device_telemetry" \
  --query-execution-context Database=robofleet_db \
  --work-group robofleet-workgroup-v3 --region us-east-1
```

> **QuickSight (optional):** Activate QuickSight manually in the AWS console first, then deploy `RobofleetQuickSightStack`. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

---

## Data Flow

```
Robot Devices
    │  JSON telemetry
    ▼
Ingest Lambda ──SSE-KMS──▶ S3 Data Lake
                              │  year/month/day partitions
                              ▼
                         Glue Catalog (device_telemetry)
                              │
               ┌──────────────┼──────────────────┐
               │              │                  │
               ▼              ▼                  ▼
          KPI Lambda    Data Quality        Query Lambda
          (every 5min)  Lambda (30min)      (every 5min)
               │              │
               ▼              ▼
         CloudWatch ◄──────── SNS ──▶ Slack / Email
         Custom Metrics       │
               │              ▼
         Alarms ──▶ SNS   (on failures)
               │
               ▼
         QuickSight ◄── Athena Views ── fleet_daily_health
         Dashboard                      device_status_summary
```

---

## Security Design

| Control | Implementation |
|---|---|
| Encryption at rest | KMS customer-managed keys (`alias/robofleet-app-key`) on all S3 data |
| Encryption in transit | TLS enforced on all S3 bucket policies + all Lambda → AWS service calls |
| No VPC required | Lambdas run outside VPC — AWS services reached via public TLS endpoints |
| Least-privilege IAM | 1 role per Lambda — no shared roles, no `*` actions |
| Secrets | Slack webhook + email config in Secrets Manager (never in env vars) |
| Upload enforcement | S3 bucket policy denies any unencrypted `PutObject` |

---

## Cost Estimate (personal/dev usage)

| Service | Usage | Est. Cost/Month |
|---|---|---|
| Lambda | 7 functions, light traffic | ~$1 |
| S3 | 100GB data lake | ~$2 |
| Athena | ~10GB scanned | ~$0.05 |
| KMS | 2 keys | ~$1 |
| CloudWatch | 10 custom metrics, 6 alarms | ~$3 |
| **Total** | | **~$7/month** |
| QuickSight Standard _(optional)_ | 1 author | +$9 |

> VPC + 7 interface endpoints (~$50/month) were removed — Lambdas run outside VPC and reach AWS services via public TLS endpoints.

---

## Documentation

| Doc | Description |
|---|---|
| [docs/architecture-visual.drawio](docs/architecture-visual.drawio) | Visual architecture diagram — open in [diagrams.net](https://app.diagrams.net) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Deep-dive: schema, Lambda details, Athena views, monitoring |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Step-by-step deployment including QuickSight setup |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | IAM, KMS, Athena workgroup common issues and fixes |
| [docs/LAMBDA_TESTING.md](docs/LAMBDA_TESTING.md) | How to invoke and verify each Lambda function |

---

**CDK:** 2.x | **Node.js:** 20.x | **Region:** us-east-1 | **Tests:** 80 passing
