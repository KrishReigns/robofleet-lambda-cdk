# Robofleet Lambda: Step-by-Step Deployment Guide

This guide walks you through deploying the complete infrastructure. Follow each step carefully.

---

## Phase 1: Environment Setup (30 minutes)

### Step 1.1: Verify Prerequisites

Check you have all required tools:

```bash
# Check Node.js version (must be 20.x or higher)
node -v
# Expected: v20.x.x

# Check npm version (must be 10.x or higher)
npm -v
# Expected: 10.x.x

# Check AWS CLI version
aws --version
# Expected: aws-cli/2.x.x

# Verify AWS credentials are configured
aws sts get-caller-identity
# Output should show your AWS account ID, user ARN, and account ID
```

If any tool is missing, install it:
```bash
# Install Node.js (via Homebrew on macOS)
brew install node

# Install AWS CLI v2
brew install awscli

# Upgrade npm
npm install -g npm@latest
```

### Step 1.2: Install AWS CDK

```bash
# Install AWS CDK v2
npm install -g aws-cdk@2.x

# Verify installation
cdk --version
# Expected: 2.x.x
```

### Step 1.3: Bootstrap AWS Account

AWS CDK requires a bootstrap stack in each region before deployment:

```bash
# Bootstrap your AWS account (one-time setup)
cdk bootstrap aws://{YOUR_ACCOUNT_ID}/{REGION}

# Example (replace with your actual account ID and region):
cdk bootstrap aws://123456789012/us-east-1

# You'll see:
# ⏳ Bootstrapping environment aws://123456789012/us-east-1...
# ✓ Environment aws://123456789012/us-east-1 bootstrapped.
```

---

## Phase 2: Project Setup (15 minutes)

### Step 2.1: Navigate to Project

```bash
cd robofleet-lambda
pwd  # Should end with /robofleet-lambda
```

### Step 2.2: Install Dependencies

```bash
# Install all npm packages (may take 2-3 minutes)
npm install

# You should see:
# added XXX packages in XXs
```

### Step 2.3: Build Project

```bash
# Compile TypeScript to JavaScript
npm run build

# Expected output:
# Successfully compiled TypeScript files
```

### Step 2.4: List Stacks

Verify CDK can find all stacks:

```bash
cdk list

# Expected output:
# RobofleetSecurityStack
# RobofleetNetworkingStack
# RobofleetStorageStack
# RobofleetComputeStack
# RobofleetCICDStack
```

### Step 2.5: Synthesize Templates

Generate CloudFormation templates:

```bash
cdk synth

# Creates cdk.out/ directory with CloudFormation templates
ls -la cdk.out/

# You should see:
# -rw-r--r--  RobofleetSecurityStack.template.json
# -rw-r--r--  RobofleetNetworkingStack.template.json
# -rw-r--r--  RobofleetStorageStack.template.json
# -rw-r--r--  RobofleetComputeStack.template.json
# -rw-r--r--  RobofleetCICDStack.template.json
```

---

## Phase 3: Review Changes (10 minutes)

### Step 3.1: View Infrastructure Diff

See what resources will be created:

```bash
cdk diff

# This outputs all resources for each stack
# Review carefully to ensure nothing unexpected
```

### Step 3.2: Estimate Costs

Review the AWS Pricing Calculator for estimated costs:
- VPC Endpoints (8): ~$7-10/month
- Lambda (1M invocations): ~$0.20
- S3 Storage (100GB): ~$2.30
- Athena (1TB scanned): ~$6.25
- Total: ~$50-200/month depending on usage

---

## Phase 4: Deploy Infrastructure (20-30 minutes)

**WARNING:** This will create real AWS resources and incur costs. Follow the deployment order strictly.

### Step 4.1: Deploy SecurityStack

```bash
# Deploy the security foundation
cdk deploy RobofleetSecurityStack

# You'll see:
# ✓ RobofleetSecurityStack
# Outputs:
# - AppKeyArn
# - AuditKeyArn
# - IamRoleArns (all 6 roles)
# - SecretsManagerSecretArns

# Time: ~2-3 minutes
```

### Step 4.2: Deploy NetworkingStack

```bash
# Deploy VPC, security groups, and VPC endpoints
cdk deploy RobofleetNetworkingStack

# You'll see:
# ✓ RobofleetNetworkingStack
# Outputs:
# - VpcId
# - PrivateSubnets
# - LambdaSecurityGroupId
# - VpcEndpoints (8 endpoints)

# Time: ~5-8 minutes (VPC endpoints take longest)
```

### Step 4.3: Deploy StorageStack

```bash
# Deploy S3 buckets, Glue database, and table
cdk deploy RobofleetStorageStack

# You'll see:
# ✓ RobofleetStorageStack
# Outputs:
# - DataLakeBucketName
# - AthenaResultsBucketName
# - GlueDatabaseName
# - DeviceTelemetryTableName

# Time: ~2-3 minutes
```

### Step 4.4: Deploy ComputeStack

```bash
# Deploy Lambda functions, SNS topics, CloudWatch resources
cdk deploy RobofleetComputeStack

# You'll see:
# ✓ RobofleetComputeStack
# Outputs:
# - IngestLambdaArn
# - QueryLambdaArn
# - ProcessingLambdaArn
# - AlertsTopicArn
# - DashboardUrl

# Time: ~3-5 minutes
```

### Step 4.5: Deploy CICDStack

```bash
# Deploy CodeCommit, CodeBuild, CodePipeline
cdk deploy RobofleetCICDStack

# You'll see:
# ✓ RobofleetCICDStack
# Outputs:
# - RepositoryCloneUrl (CodeCommit HTTP URL)
# - PipelineUrl (CodePipeline console URL)

# Time: ~2-3 minutes
```

### Step 4.6: Verify All Stacks

```bash
# List all created stacks
aws cloudformation list-stacks \
  --query 'StackSummaries[?contains(StackName, `robofleet`) && StackStatus==`CREATE_COMPLETE`].StackName' \
  --output table

# Expected output:
# ├─ robofleet-security-stack
# ├─ robofleet-networking-stack
# ├─ robofleet-storage-stack
# ├─ robofleet-compute-stack
# └─ robofleet-cicd-stack
```

---

## Phase 5: Post-Deployment Configuration (15 minutes)

### Step 5.1: Configure Slack Integration

Get your Slack webhook URL from Slack API console, then:

```bash
# Store Slack webhook in Secrets Manager
aws secretsmanager create-secret \
  --name robofleet/slack-webhook \
  --secret-string 'https://hooks.slack.com/services/YOUR/WEBHOOK/URL'

# Verify secret created
aws secretsmanager describe-secret \
  --secret-id robofleet/slack-webhook
```

### Step 5.2: Verify Email Domain in SES

Before email alerts work, verify the sender email:

```bash
# Verify email address
aws ses verify-email-identity \
  --email-address noreply@yourcompany.com

# Check verification status
aws ses list-verified-email-addresses

# Look for confirmation email in your inbox
# Click the verification link
```

### Step 5.3: Create Email Config Secret

```bash
# Create email configuration secret
aws secretsmanager create-secret \
  --name robofleet/email-config \
  --secret-string '{
    "from_email": "noreply@yourcompany.com",
    "smtp_host": "email-smtp.us-east-1.amazonaws.com",
    "smtp_port": 587,
    "recipient_emails": ["alerts@yourcompany.com"]
  }'

# Verify secret created
aws secretsmanager describe-secret \
  --secret-id robofleet/email-config
```

### Step 5.4: Enable SES in Production Mode

By default, SES is in sandbox mode (limited sending):

```bash
# Request production access via AWS Console:
# 1. Go to SES console
# 2. Navigate to Account dashboard
# 3. Click "Request production access"
# 4. Wait for approval (typically 24 hours)
```

---

## Phase 6: Verification (15 minutes)

### Step 6.1: Verify S3 Buckets

```bash
# List created S3 buckets
aws s3 ls | grep robofleet

# Expected output:
# 2025-03-27 12:34:56 robofleet-data-lake-123456789012
# 2025-03-27 12:34:56 robofleet-athena-results-123456789012
# 2025-03-27 12:34:56 robofleet-cicd-artifacts-123456789012
```

### Step 6.2: Verify Lambda Functions

```bash
# List created Lambda functions
aws lambda list-functions \
  --query 'Functions[?contains(FunctionName, `robofleet`)].FunctionName' \
  --output table

# Expected output:
# ├─ robofleet-ingest
# ├─ robofleet-query
# ├─ robofleet-processing
# ├─ robofleet-sns-to-slack
# └─ robofleet-sns-to-email
```

### Step 6.3: Verify VPC Resources

```bash
# Get VPC ID
VPC_ID=$(aws ec2 describe-vpcs \
  --filters "Name=tag:Name,Values=robofleet-vpc" \
  --query 'Vpcs[0].VpcId' \
  --output text)

echo "VPC ID: $VPC_ID"

# List VPC endpoints
aws ec2 describe-vpc-endpoints \
  --filters "Name=vpc-id,Values=$VPC_ID" \
  --query 'VpcEndpoints[].ServiceName' \
  --output table
```

### Step 6.4: Verify Glue Database

```bash
# Get Glue database
aws glue get-database --name robofleet_db

# Get Glue table
aws glue get-table \
  --database-name robofleet_db \
  --name device_telemetry

# Expected output shows:
# - 9 data columns (device_id, fleet_id, etc.)
# - 3 partition columns (year, month, day)
# - CSV format with LazySimpleSerDe
# - S3 location: s3://robofleet-data-lake-{account}/telemetry/
```

### Step 6.5: Test Lambda Functions

```bash
# Test Ingest Lambda
aws lambda invoke \
  --function-name robofleet-ingest \
  --payload '{"device_id":"ROBOT-001","battery_level":85.5}' \
  response.json
cat response.json

# Test Query Lambda
aws lambda invoke \
  --function-name robofleet-query \
  --payload '{"query":"SELECT COUNT(*) FROM device_telemetry"}' \
  response.json
cat response.json
```

### Step 6.6: Access CloudWatch Dashboard

```bash
# Get dashboard URL from stack outputs
aws cloudformation describe-stacks \
  --stack-name robofleet-compute-stack \
  --query 'Stacks[0].Outputs[?OutputKey==`DashboardUrl`].OutputValue' \
  --output text

# Open in browser to view metrics
```

---

## Phase 7: First Pipeline Run (5 minutes)

### Step 7.1: Clone CodeCommit Repository

```bash
# Get repository URL
REPO_URL=$(aws cloudformation describe-stacks \
  --stack-name robofleet-cicd-stack \
  --query 'Stacks[0].Outputs[?OutputKey==`RepositoryCloneUrl`].OutputValue' \
  --output text)

echo "Repository URL: $REPO_URL"

# Clone (credentials required - use AWS CodeCommit credentials)
git clone $REPO_URL robofleet-lambda-repo

cd robofleet-lambda-repo
```

### Step 7.2: Push Code to CodeCommit

```bash
# Copy all infrastructure files to the cloned repository
cp -r ../robofleet-lambda/* .
git add .
git commit -m "Initial infrastructure setup"
git push origin main

# CodePipeline will automatically trigger
```

### Step 7.3: Monitor Pipeline Execution

```bash
# Get pipeline URL
PIPELINE_URL=$(aws cloudformation describe-stacks \
  --stack-name robofleet-cicd-stack \
  --query 'Stacks[0].Outputs[?OutputKey==`PipelineUrl`].OutputValue' \
  --output text)

echo "Pipeline URL: $PIPELINE_URL"

# Watch pipeline progress
aws codepipeline get-pipeline-state --name robofleet-pipeline --query 'stageStates[*].[stageName,latestExecution.status]' --output table
```

---

## Phase 8: Final Verification (10 minutes)

### Step 8.1: CloudWatch Logs

```bash
# Check Lambda execution logs
aws logs describe-log-groups \
  --log-group-name-prefix '/aws/lambda/robofleet' \
  --query 'logGroups[].logGroupName' \
  --output table

# Tail recent logs
aws logs tail /aws/lambda/ingest --follow
```

### Step 8.2: SNS Topics

```bash
# Get alerts topic ARN
TOPIC_ARN=$(aws cloudformation describe-stacks \
  --stack-name robofleet-compute-stack \
  --query 'Stacks[0].Outputs[?OutputKey==`AlertsTopicArn`].OutputValue' \
  --output text)

echo "Alerts Topic: $TOPIC_ARN"

# List subscriptions
aws sns list-subscriptions-by-topic --topic-arn $TOPIC_ARN
```

### Step 8.3: EventBridge Rules

```bash
# List active rules
aws events list-rules --name-prefix 'robofleet' --query 'Rules[*].Name' --output table

# Expected:
# ├─ robofleet-query-schedule-rule
# └─ robofleet-processing-schedule-rule
```

---

## Cleanup (Optional)

**WARNING:** This will delete all resources and cannot be undone.

```bash
# Delete all stacks in reverse order
cdk destroy RobofleetCICDStack
cdk destroy RobofleetComputeStack
cdk destroy RobofleetStorageStack
cdk destroy RobofleetNetworkingStack
cdk destroy RobofleetSecurityStack

# Confirm deletion when prompted
```

---

## Success Checklist

- ✅ All 5 stacks deployed successfully
- ✅ S3 buckets created and accessible
- ✅ Lambda functions created with correct configurations
- ✅ VPC with 8 endpoints created
- ✅ Glue database and table created
- ✅ CloudWatch dashboard accessible
- ✅ CodeCommit repository cloned and code pushed
- ✅ CodePipeline completed successfully
- ✅ Slack webhook configured
- ✅ Email verified in SES

---

## Troubleshooting

### Deployment Fails with "InsufficientPermissions"
- Ensure AWS credentials have AdministratorAccess or equivalent
- Check `aws sts get-caller-identity` output

### VPC Endpoint Creation Times Out
- This is normal, VPC endpoints take 5-10 minutes to create
- Wait and re-run `cdk deploy` if needed

### Lambda Functions Show Errors
- Lambda code is placeholder (in Lambda handler files)
- Actual implementation comes in Day 2

### CodeBuild Fails
- Ensure buildspec.yml is in repository root
- Check CodeBuild logs in CloudWatch: `/aws/codebuild/robofleet-build`

---

**Total Deployment Time:** ~1 hour (including post-deployment configuration)

**Estimated Cost:** $50-200/month depending on usage

Next Steps: Implement Lambda functions and tests (Day 2-3)
