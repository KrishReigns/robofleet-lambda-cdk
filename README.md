# RoboFleet Lambda - Serverless Telemetry Analytics

Real-time device telemetry ingestion and analytics on AWS using Lambda, S3, Glue, and Athena. Built with TypeScript and AWS CDK.

**Stack:** AWS CDK · TypeScript · Lambda · S3 · Athena · Glue · CloudWatch · SNS/SES

---

## Documentation

| Doc | Description |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, data schema, Lambda functions, sample queries |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Step-by-step deployment guide |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common issues and fixes |
| [docs/LAMBDA_TESTING.md](docs/LAMBDA_TESTING.md) | How to test each Lambda function |

---

## Quick Start

```bash
npm install
npm run build
cdk deploy --all --region us-east-1 --require-approval never
```

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full deployment guide including Athena configuration, sample data upload, and partition registration.

---

## Project Structure

```
robofleet-lambda-cdk/
├── bin/
│   └── app.ts                    # CDK app entry point
├── lib/stacks/
│   ├── security-stack.ts         # KMS, IAM, Secrets Manager
│   ├── networking-stack.ts       # VPC, subnets, VPC endpoints
│   ├── storage-stack.ts          # S3, Glue database/table
│   ├── compute-stack.ts          # Lambda, SNS, CloudWatch
│   └── cicd-stack.ts             # CodeCommit, CodeBuild, CodePipeline
├── src/functions/
│   ├── ingest/index.ts           # Receives telemetry, writes to S3
│   ├── query/index.ts            # Executes Athena SQL queries
│   ├── processing/index.ts       # Aggregates raw telemetry
│   ├── sns-to-slack/index.ts     # Routes alerts to Slack
│   └── sns-to-email/index.ts     # Routes alerts via SES
├── tests/unit/                   # Jest unit tests
├── data-seed/                    # Sample telemetry CSV files
├── scripts/                      # Deployment and verification scripts
└── docs/                         # Documentation
```

---

## Infrastructure Overview

5 CDK stacks deployed in dependency order:

```
SecurityStack → NetworkingStack → StorageStack → ComputeStack → CICDStack
```

- SecurityStack — KMS keys, IAM roles, Secrets Manager
- NetworkingStack — VPC (10.0.0.0/16), private subnets, 7 VPC endpoints
- StorageStack — S3 data lake, Athena results bucket, Glue catalog
- ComputeStack — 5 Lambda functions, SNS alerts, CloudWatch monitoring
- CICDStack — CodePipeline with manual approval gate

---

## Security

- KMS customer-managed encryption on all data
- Least-privilege IAM per Lambda function
- Private VPC with no internet access (VPC endpoints only)
- Secrets Manager for all credentials

---

**CDK Version:** 2.x | **Node.js:** 20.x | **Region:** us-east-1
