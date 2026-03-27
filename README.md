# Robofleet Lambda: Production AWS CDK Infrastructure

Complete end-to-end production AWS infrastructure for a robotics fleet telemetry system using TypeScript and AWS CDK.

**Project Status:** Infrastructure code complete (stacks 1-5), ready for first deployment
**Target Role:** Amazon Robotics Cloud Developer
**Technology Stack:** AWS CDK, TypeScript, AWS Lambda, S3, Athena, Glue, CloudWatch

---

## Architecture Overview

### Data Flow
```
Device Telemetry → S3 Data Lake → Glue Catalog → Athena (SQL) → QuickSight Dashboards
                  ↓
            Lambda Functions (Ingest, Processing)
                  ↓
            CloudWatch Monitoring & Alarms
                  ↓
            SNS → Slack / Email Notifications
```

### Infrastructure Stack Hierarchy
```
1. SecurityStack (foundation)
   ├── KMS Keys (appKey, auditKey)
   ├── IAM Roles (5 Lambda execution roles + Glue role)
   └── Secrets Manager (Slack webhook, Email config)

2. NetworkingStack (depends on SecurityStack)
   ├── VPC (10.0.0.0/16, 2 AZs)
   ├── Security Groups (Lambda, VPC endpoints)
   └── VPC Endpoints (8 services: S3, Glue, Athena, SNS, Secrets Manager, etc.)

3. StorageStack (depends on SecurityStack)
   ├── S3 Data Lake (robofleet-data-lake)
   ├── S3 Athena Results (robofleet-athena-results)
   ├── Glue Database (robofleet_db)
   └── Glue Table (device_telemetry - 9 data columns + 3 partitions)

4. ComputeStack (depends on 1-3)
   ├── Lambda Functions (5 total)
   │   ├── Ingest: Receives telemetry, stores in S3
   │   ├── Query: Executes Athena SQL queries
   │   ├── Processing: Optimizes telemetry for Athena
   │   ├── SNS-to-Slack: Routes alerts to Slack
   │   └── SNS-to-Email: Routes alerts via SES
   ├── SNS Topic (AlertsTopic)
   ├── CloudWatch Dashboard (10+ metrics)
   └── CloudWatch Alarms (3+ triggers)

5. CICDStack (independent)
   ├── CodeCommit Repository (source control)
   ├── CodeBuild Project (compile, test, synthesize)
   └── CodePipeline (Source → Build → Deploy → Manual Approval)
```

---

## Deployment Instructions

### Prerequisites
- Node.js 20.x LTS
- AWS CLI v2 configured with credentials
- AWS CDK CLI: `npm install -g aws-cdk`

### Quick Start

```bash
# 1. Install dependencies
cd robofleet-lambda
npm install

# 2. Validate project
npm run build
cdk list

# 3. Deploy infrastructure (in order)
cdk deploy RobofleetSecurityStack
cdk deploy RobofleetNetworkingStack
cdk deploy RobofleetStorageStack
cdk deploy RobofleetComputeStack
cdk deploy RobofleetCICDStack

# 4. Verify deployment
aws cloudformation list-stacks --query 'StackSummaries[?contains(StackName, `robofleet`)].StackName'
```

**Deployment Time:** ~15-20 minutes total

### Configuration After Deployment

#### 1. Set Slack Webhook Secret
```bash
aws secretsmanager create-secret \
  --name robofleet/slack-webhook \
  --secret-string 'https://hooks.slack.com/services/YOUR/WEBHOOK/URL'
```

#### 2. Verify Email in SES
```bash
aws ses verify-email-identity --email-address noreply@yourcompany.com
```

#### 3. Create Email Config Secret
```bash
aws secretsmanager create-secret \
  --name robofleet/email-config \
  --secret-string '{
    "from_email": "noreply@yourcompany.com",
    "smtp_host": "email-smtp.us-east-1.amazonaws.com",
    "smtp_port": 587
  }'
```

---

## Project Structure

```
robofleet-lambda/
├── bin/
│   └── app.ts                          # CDK app entry point
├── lib/stacks/
│   ├── networking-stack.ts             # VPC, security groups, endpoints
│   ├── security-stack.ts               # KMS, IAM, Secrets Manager
│   ├── storage-stack.ts                # S3, Glue database/table
│   ├── compute-stack.ts                # Lambda, SNS, CloudWatch
│   └── cicd-stack.ts                   # CodeCommit, CodeBuild, Pipeline
├── src/functions/
│   ├── ingest/handler.ts               # Ingest Lambda (Day 2)
│   ├── query/handler.ts                # Query Lambda (Day 2)
│   ├── processing/handler.ts           # Processing Lambda (Day 2)
│   ├── sns-to-slack/handler.ts         # Slack Lambda (Day 2)
│   └── sns-to-email/handler.ts         # Email Lambda (Day 2)
├── tests/
│   └── unit/                           # Jest tests (Day 3)
├── buildspec.yml                       # CodeBuild configuration
├── package.json                        # Dependencies
├── tsconfig.json                       # TypeScript config
├── jest.config.js                      # Jest config
├── cdk.json                            # CDK config
└── README.md                           # This file
```

---

## Architecture Components

### SecurityStack
- **KMS Keys:** appKey (application data), auditKey (logs)
- **IAM Roles:** 6 roles (5 Lambda + 1 Glue service)
- **Secrets Manager:** Slack webhook, Email config

### NetworkingStack
- **VPC:** 10.0.0.0/16 across 2 AZs
- **Subnets:** Private only (no internet gateway)
- **VPC Endpoints:** 8 services (S3, Glue, Athena, SNS, Secrets Manager, SES, CloudWatch Logs)
- **Security Groups:** Restricted egress (443 to Slack only)

### StorageStack
- **S3 Data Lake:** Versioned, encrypted, 30-day Intelligent-Tiering, 365-day expiration
- **S3 Athena Results:** Query outputs with 30-day expiration
- **Glue Database:** robofleet_db
- **Glue Table:** device_telemetry (9 data columns + 3 partition keys)

### ComputeStack
- **Lambda Functions:**
  - Ingest: Receives telemetry, stores in S3
  - Query: Executes Athena SQL queries
  - Processing: Optimizes telemetry data
  - SNS-to-Slack: Routes alerts to Slack
  - SNS-to-Email: Routes alerts via SES
- **SNS Topic:** AlertsTopic (routes to Slack + Email)
- **CloudWatch:** Dashboard (10+ metrics), 3 Alarms
- **EventBridge:** 2 scheduled rules (5min query, 10min processing)

### CICDStack
- **CodeCommit:** Repository (robofleet-lambda)
- **CodeBuild:** Compile, test, synthesize (buildspec.yml)
- **CodePipeline:** Source → Build → Manual Approval → Deploy

---

## Monitoring

### CloudWatch Dashboard
```
https://console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards:name=robofleet-metrics
```

### Key Metrics
- Lambda invocations per function
- Lambda duration (average, p99)
- Lambda errors and throttles
- SNS messages published
- S3 object count and size

### Alarms
- High error rate (>5 errors/5min)
- Lambda throttling (any event)
- Slow queries (>30s average)

---

## Next Steps

### Day 2: Lambda Functions
- [ ] Implement ingest handler (receives telemetry)
- [ ] Implement query handler (Athena SQL)
- [ ] Implement processing handler (data optimization)
- [ ] Implement SNS-to-Slack handler
- [ ] Implement SNS-to-Email handler
- [ ] Add QuickSight dashboard

### Day 3: Testing & Documentation
- [ ] Write Jest unit tests (20+ cases)
- [ ] Achieve 80%+ code coverage
- [ ] Create architecture diagram
- [ ] Push to GitHub
- [ ] Verify CodePipeline

---

## Troubleshooting

### VPC Endpoint Timeout
```bash
# Verify endpoint created
aws ec2 describe-vpc-endpoints --filters Name=vpc-id,Values={vpc-id}
```

### Athena Query Fails
```bash
# Check Glue table
aws glue get-table --database-name robofleet_db --name device_telemetry

# Check S3 data
aws s3 ls s3://robofleet-data-lake-{account}/telemetry/ --recursive
```

### Slack Not Receiving Alerts
```bash
# Check Lambda logs
aws logs tail /aws/lambda/sns-to-slack --follow

# Verify secret
aws secretsmanager describe-secret --secret-id robofleet/slack-webhook
```

---

## Cost Estimate

| Service | Usage | Cost/Month |
|---------|-------|-----------|
| VPC Endpoints | 8 interfaces | $7-10 |
| Lambda | 1M invocations | $0.20 |
| S3 Data Lake | 100GB | $2.30 |
| Athena | 1TB scanned | $6.25 |
| KMS | 2 keys | $1.00 |
| **Total** | | **$50-200** |

---

## Security Checklist

- ✅ KMS encryption (customer-managed keys)
- ✅ Least-privilege IAM (no wildcards)
- ✅ VPC with private subnets
- ✅ Security groups with restricted egress
- ✅ VPC endpoints (no internet access)
- ✅ Secrets Manager for credentials
- ✅ S3 block public access
- ✅ CloudWatch logs encrypted
- ✅ Separate keys for audit/app data

---

**Last Updated:** 2025-03-27
**CDK Version:** 2.x | **Node.js:** 20.x
