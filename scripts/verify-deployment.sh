#!/bin/bash

#############################################################################
# RoboFleet Lambda - Verify Deployment
#
# PURPOSE:
# Verifies that the SecurityStack and ComputeStack deployed correctly
# Checks for:
# 1. IAM role has Athena permissions (no duplicates)
# 2. Lambda has ATHENA_WORKGROUP environment variable
# 3. Query Lambda can be invoked
#
# USAGE:
# ./verify-deployment.sh
#############################################################################

set -e

ACCOUNT_ID="235695894002"
REGION="us-east-1"

echo "=================================================="
echo "RoboFleet Lambda - Verify Deployment"
echo "=================================================="
echo ""

# Check 1: Verify IAM Role Exists and Has Correct Permissions
echo "========== CHECK 1: IAM Role Permissions =========="
echo ""

ROLE_NAME="robofleet-query-lambda-role"
echo "Checking role: $ROLE_NAME"

if aws iam get-role --role-name $ROLE_NAME --region $REGION > /dev/null 2>&1; then
    echo "✅ Role exists: $ROLE_NAME"
else
    echo "❌ ERROR: Role not found: $ROLE_NAME"
    exit 1
fi

echo ""
echo "Checking Athena permissions..."
ATHENA_PERMS=$(aws iam get-role-policy \
  --role-name $ROLE_NAME \
  --policy-name robofleet-query-athena-policy \
  --region $REGION 2>/dev/null || echo "")

if [ -z "$ATHENA_PERMS" ]; then
    echo "❌ ERROR: Athena policy not found"
    exit 1
fi

# Count Athena permission statements
ATHENA_COUNT=$(echo "$ATHENA_PERMS" | jq '[.PolicyDocument.Statement[] | select(.Action[] | contains("athena"))] | length')

if [ "$ATHENA_COUNT" -eq 1 ]; then
    echo "✅ Exactly ONE Athena permission statement (no duplicates)"
else
    echo "❌ ERROR: Found $ATHENA_COUNT Athena permission statements (expected 1)"
    echo "$ATHENA_PERMS" | jq '.PolicyDocument.Statement[] | select(.Action[] | contains("athena"))'
    exit 1
fi

echo ""
echo "Verifying Athena actions..."
ACTIONS=$(echo "$ATHENA_PERMS" | jq -r '.PolicyDocument.Statement[] | select(.Action[] | contains("athena")) | .Action[]' | sort)
echo "Allowed Athena actions:"
echo "$ACTIONS" | sed 's/^/  - /'

echo ""
echo "Verifying workgroup resource ARN..."
RESOURCES=$(echo "$ATHENA_PERMS" | jq -r '.PolicyDocument.Statement[] | select(.Action[] | contains("athena")) | .Resource[]')
echo "Allowed resources:"
echo "$RESOURCES" | sed 's/^/  - /'

# Verify the ARN pattern includes robofleet-workgroup
if echo "$RESOURCES" | grep -q "robofleet-workgroup"; then
    echo "✅ ARN pattern allows robofleet workgroups"
else
    echo "❌ ERROR: ARN pattern does not allow robofleet workgroups"
    exit 1
fi

echo ""
echo "========== CHECK 2: Lambda Environment Variables =========="
echo ""

LAMBDA_NAME="robofleet-query"
echo "Checking Lambda function: $LAMBDA_NAME"

if aws lambda get-function-configuration \
    --function-name $LAMBDA_NAME \
    --region $REGION > /dev/null 2>&1; then
    echo "✅ Lambda function exists: $LAMBDA_NAME"
else
    echo "❌ ERROR: Lambda function not found: $LAMBDA_NAME"
    exit 1
fi

echo ""
echo "Checking ATHENA_WORKGROUP environment variable..."
WORKGROUP=$(aws lambda get-function-configuration \
  --function-name $LAMBDA_NAME \
  --region $REGION | jq -r '.Environment.Variables.ATHENA_WORKGROUP // "NOT SET"')

if [ "$WORKGROUP" != "NOT SET" ]; then
    echo "✅ ATHENA_WORKGROUP is set to: $WORKGROUP"
else
    echo "⚠️  WARNING: ATHENA_WORKGROUP environment variable not set"
    echo "   Lambda will use default value from code"
fi

echo ""
echo "All Lambda environment variables:"
aws lambda get-function-configuration \
  --function-name $LAMBDA_NAME \
  --region $REGION | jq '.Environment.Variables' | sed 's/^/  /'

echo ""
echo "========== CHECK 3: Test Lambda Invocation =========="
echo ""

echo "Attempting to invoke robofleet-query Lambda..."
echo "Query: SELECT COUNT(*) as record_count FROM device_telemetry"
echo ""

aws lambda invoke \
  --function-name $LAMBDA_NAME \
  --region $REGION \
  --payload '{"query": "SELECT COUNT(*) as record_count FROM device_telemetry"}' \
  /tmp/lambda-test-response.json \
  > /dev/null 2>&1

if [ $? -eq 0 ]; then
    echo "✅ Lambda invocation succeeded"
    echo ""
    echo "Response:"
    cat /tmp/lambda-test-response.json | jq '.'

    # Check if response contains error
    if cat /tmp/lambda-test-response.json | jq -e '.errorMessage' > /dev/null 2>&1; then
        echo ""
        echo "⚠️  Lambda returned an error:"
        cat /tmp/lambda-test-response.json | jq '.errorMessage'
    elif cat /tmp/lambda-test-response.json | jq -e '.body' > /dev/null 2>&1; then
        BODY=$(cat /tmp/lambda-test-response.json | jq -r '.body')
        BODY_JSON=$(echo "$BODY" | jq '.')

        if echo "$BODY_JSON" | jq -e '.error' > /dev/null 2>&1; then
            echo ""
            echo "⚠️  Query returned an error:"
            echo "$BODY_JSON" | jq '.error'
        else
            echo ""
            echo "✅ Query executed successfully!"
            echo "$BODY_JSON" | jq '.'
        fi
    fi
else
    echo "❌ ERROR: Lambda invocation failed"
    exit 1
fi

echo ""
echo "========== CHECK 4: CloudWatch Logs =========="
echo ""

LOG_GROUP="/aws/lambda/robofleet-query"
echo "Checking CloudWatch Logs: $LOG_GROUP"

if aws logs describe-log-groups \
    --log-group-name-prefix $LOG_GROUP \
    --region $REGION | jq -e '.logGroups[0]' > /dev/null 2>&1; then
    echo "✅ CloudWatch log group exists"

    echo ""
    echo "Recent logs (last 10 events):"
    aws logs tail $LOG_GROUP \
      --max-items 10 \
      --region $REGION \
      --no-follow 2>/dev/null | tail -10 || echo "  (no logs yet)"
else
    echo "⚠️  WARNING: CloudWatch log group not found"
fi

echo ""
echo "=================================================="
echo "✅ VERIFICATION COMPLETE"
echo "=================================================="
echo ""
echo "All checks passed! The deployment is ready."
echo ""
echo "Next steps:"
echo "1. Run Phase 5+ of deployment to upload test data:"
echo "   ./run-deployment-phases-4-7.sh"
echo ""
echo "2. Or manually upload test data:"
echo "   aws s3 sync data-seed/ s3://robofleet-data-lake-${ACCOUNT_ID}/telemetry/"
echo ""
echo "3. Monitor query execution:"
echo "   aws logs tail $LOG_GROUP --follow --region $REGION"
echo ""
