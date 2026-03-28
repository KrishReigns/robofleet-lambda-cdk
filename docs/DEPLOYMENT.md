# RoboFleet Lambda - Deployment Guide

## Prerequisites

- AWS Account with credentials configured (`aws configure`)
- Node.js 20.x and npm
- CDK CLI: `npm install -g aws-cdk`

## Environment Setup

```bash
cd ~/Desktop/robofleet-lambda-cdk

# Install dependencies
npm install

# Bootstrap CDK (one-time setup per account/region)
cdk bootstrap aws://235695894002/us-east-1
```

---

## Phase 1: Synthesize & Validate

```bash
npm run build
cdk synth
```

Expected stacks in `cdk.out/`:
- RobofleetSecurityStack
- RobofleetNetworkingStack
- RobofleetStorageStack
- RobofleetComputeStack
- RobofleetCICDStack

---

## Phase 2: Deploy Infrastructure (~15-20 minutes)

Deploy in this exact order:

```bash
# 1. Security (KMS keys, IAM roles, Secrets Manager)
cdk deploy RobofleetSecurityStack --region us-east-1 --require-approval never

# 2. Storage (S3 buckets, Glue database/table)
cdk deploy RobofleetStorageStack --region us-east-1 --require-approval never

# 3. Networking (VPC, security groups, VPC endpoints)
cdk deploy RobofleetNetworkingStack --region us-east-1 --require-approval never

# 4. Compute (Lambda functions, SNS, CloudWatch)
cdk deploy RobofleetComputeStack --region us-east-1 --require-approval never

# 5. CI/CD (optional)
cdk deploy RobofleetCICDStack --region us-east-1 --require-approval never
```

Verify all stacks deployed:
```bash
aws cloudformation list-stacks \
  --query 'StackSummaries[?contains(StackName, `robofleet`) && StackStatus==`CREATE_COMPLETE`].StackName' \
  --region us-east-1
```

---

## Phase 3: Configure Athena Workgroup

Set the ExecutionRole on the workgroup (required for Lambda to run queries):

```bash
aws athena update-work-group \
  --work-group robofleet-workgroup-v2 \
  --configuration "ResultConfiguration={OutputLocation=s3://robofleet-athena-results-235695894002/query-results/,EncryptionConfiguration={EncryptionOption=SSE_S3}},ExecutionRole=arn:aws:iam::235695894002:role/robofleet-athena-service-role,EnforceWorkGroupConfiguration=true,PublishCloudWatchMetricsEnabled=true" \
  --region us-east-1
```

Verify:
```bash
aws athena get-work-group --work-group robofleet-workgroup-v2 --region us-east-1 \
  | jq '.WorkGroup.Configuration.ExecutionRole'
# Expected: "arn:aws:iam::235695894002:role/robofleet-athena-service-role"
```

---

## Phase 4: Configure Secrets

### Slack Webhook
```bash
aws secretsmanager create-secret \
  --name robofleet/slack-webhook \
  --secret-string '{"slack_webhook_url": "https://hooks.slack.com/services/YOUR/WEBHOOK/URL"}' \
  --region us-east-1
```

### Email Config
```bash
# Verify sender email in SES first
aws ses verify-email-identity --email-address noreply@yourcompany.com --region us-east-1

# Create email config secret
aws secretsmanager create-secret \
  --name robofleet/email-config \
  --secret-string '{
    "sender_email": "noreply@yourcompany.com",
    "recipient_emails": ["alerts@yourcompany.com"]
  }' \
  --region us-east-1
```

---

## Phase 5: Upload Sample Data

```bash
aws s3 sync data-seed/ \
  s3://robofleet-data-lake-235695894002/telemetry/ \
  --region us-east-1
```

Verify:
```bash
aws s3 ls s3://robofleet-data-lake-235695894002/telemetry/ --recursive --region us-east-1 | wc -l
# Expected: 3 or more CSV files
```

---

## Phase 6: Register Partitions

Tell Athena about the S3 partition structure:

```bash
aws athena start-query-execution \
  --query-string "MSCK REPAIR TABLE device_telemetry" \
  --query-execution-context Database=robofleet_db \
  --result-configuration OutputLocation=s3://robofleet-athena-results-235695894002/query-results/ \
  --work-group robofleet-workgroup-v2 \
  --region us-east-1
```

Wait ~30 seconds, then verify partitions were registered:
```bash
aws athena start-query-execution \
  --query-string "SHOW PARTITIONS device_telemetry" \
  --query-execution-context Database=robofleet_db \
  --result-configuration OutputLocation=s3://robofleet-athena-results-235695894002/query-results/ \
  --work-group robofleet-workgroup-v2 \
  --region us-east-1
```

---

## Phase 7: Test

```bash
python3 scripts/test_lambda_query.py
```

Or invoke the Query Lambda directly:
```bash
aws lambda invoke \
  --function-name robofleet-query \
  --region us-east-1 \
  --payload '{"query": "SELECT COUNT(*) as record_count FROM device_telemetry"}' \
  /tmp/result.json

cat /tmp/result.json | jq '.'
```

Expected:
```json
{
  "statusCode": 200,
  "body": "{\"message\":\"Query executed successfully\",\"resultCount\":1,\"results\":[{\"record_count\":\"90\"}]}"
}
```

---

## Cleaning Up

```bash
# Destroy in reverse dependency order
cdk destroy RobofleetComputeStack --force
cdk destroy RobofleetNetworkingStack --force
cdk destroy RobofleetStorageStack --force
cdk destroy RobofleetSecurityStack --force
cdk destroy RobofleetCICDStack --force
```

Note: S3 buckets and KMS keys have `RemovalPolicy.RETAIN` — delete them manually if needed.

---

## Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common issues and fixes.
