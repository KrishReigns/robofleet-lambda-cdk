#!/bin/bash

#############################################################################
# RoboFleet Lambda - Deploy Fixed Stacks
#
# PURPOSE:
# This script deploys the SecurityStack and ComputeStack with fixes for:
# 1. Removed duplicate Athena permission statement in IAM role
# 2. Added missing ATHENA_WORKGROUP environment variable to Query Lambda
#
# REQUIREMENTS:
# - AWS CLI configured with credentials (aws configure)
# - AWS account: 235695894002
# - AWS region: us-east-1
# - Node.js and npm installed
#
# USAGE:
# ./deploy-fixed-stacks.sh
#############################################################################

set -e

echo "=================================================="
echo "RoboFleet Lambda - Deploy Fixed Stacks"
echo "=================================================="
echo ""

# Configuration
ACCOUNT_ID="235695894002"
REGION="us-east-1"

# Verify AWS credentials are configured
echo "Verifying AWS credentials..."
if ! aws sts get-caller-identity --region ${REGION} > /dev/null 2>&1; then
    echo "❌ ERROR: AWS credentials not configured"
    echo ""
    echo "Please run: aws configure"
    echo "Then run this script again"
    exit 1
fi

CURRENT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text --region ${REGION})
if [ "$CURRENT_ACCOUNT" != "$ACCOUNT_ID" ]; then
    echo "❌ ERROR: Current AWS account ($CURRENT_ACCOUNT) does not match expected account ($ACCOUNT_ID)"
    exit 1
fi

echo "✅ AWS credentials verified for account: $CURRENT_ACCOUNT"
echo "✅ Region: $REGION"
echo ""

# Build the CDK project
echo "========== Building CDK Project =========="
npm run build

echo ""
echo "========== Deploying SecurityStack =========="
echo "Changes:"
echo "  - Removed duplicate Athena permission statement"
echo "  - Consolidated workgroup resource ARN to: robofleet-workgroup*"
echo ""

export CDK_DEFAULT_ACCOUNT=${ACCOUNT_ID}
export CDK_DEFAULT_REGION=${REGION}

npx cdk deploy RobofleetSecurityStack --require-approval never

echo ""
echo "✅ SecurityStack deployed successfully!"
echo ""

# Deploy ComputeStack to pick up the new Lambda environment variable
echo "========== Deploying ComputeStack =========="
echo "Changes:"
echo "  - Added ATHENA_WORKGROUP environment variable"
echo "  - Lambda now explicitly configured with workgroup: robofleet-workgroup-v3"
echo ""

npx cdk deploy RobofleetComputeStack --require-approval never

echo ""
echo "✅ ComputeStack deployed successfully!"
echo ""

echo "=================================================="
echo "✅ DEPLOYMENT COMPLETE"
echo "=================================================="
echo ""
echo "Summary of changes deployed:"
echo "  1. SecurityStack: Removed duplicate Athena permissions"
echo "  2. ComputeStack: Added ATHENA_WORKGROUP environment variable"
echo ""
echo "Next steps:"
echo "  1. Test Query Lambda with:"
echo "     aws lambda invoke --function-name robofleet-query \\"
echo "       --region us-east-1 \\"
echo "       --payload '{\"query\": \"SELECT COUNT(*) as record_count FROM device_telemetry\"}' \\"
echo "       response.json"
echo "     cat response.json | jq '.'"
echo ""
echo "  2. Check CloudWatch Logs:"
echo "     aws logs tail /aws/lambda/robofleet-query --follow --region us-east-1"
echo ""
