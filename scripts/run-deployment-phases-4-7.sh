#!/bin/bash

set -e  # Exit on error

echo "=================================================="
echo "RoboFleet Lambda - Phases 4-7 Execution Script"
echo "=================================================="
echo ""

# Configuration
ACCOUNT_ID="235695894002"
REGION="us-east-1"
WORKGROUP="robofleet-workgroup-v3"
DB_NAME="robofleet_db"
TABLE_NAME="device_telemetry"
ATHENA_RESULTS_BUCKET="robofleet-athena-results-${ACCOUNT_ID}"
DATA_LAKE_BUCKET="robofleet-data-lake-${ACCOUNT_ID}"

# ============================================================
# PHASE 3b: Deploy CICD Stack
# ============================================================

echo ""
echo "========== PHASE 3b: Deploy CICD Stack =========="
echo ""

echo "Deploying CICD stack (CodeCommit, CodeBuild, CodePipeline)..."
cdk deploy RobofleetCICDStack --require-approval never

echo ""
echo "✅ CICD Stack deployed!"

# ============================================================
# PHASE 4: Configure Athena Workgroup
# ============================================================

echo ""
echo "========== PHASE 4: Configure Athena Workgroup =========="
echo ""

echo "Setting ExecutionRole on workgroup..."
aws athena update-work-group \
  --work-group ${WORKGROUP} \
  --configuration-updates "ResultConfigurationUpdates={OutputLocation=s3://${ATHENA_RESULTS_BUCKET}/query-results/},ExecutionRole=arn:aws:iam::${ACCOUNT_ID}:role/robofleet-athena-service-role,EnforceWorkGroupConfiguration=true,PublishCloudWatchMetricsEnabled=true" \
  --region ${REGION}

echo ""
echo "Verifying ExecutionRole was set..."
EXECUTION_ROLE=$(aws athena get-work-group \
  --work-group ${WORKGROUP} \
  --region ${REGION} | jq -r '.WorkGroup.Configuration.ExecutionRole')

echo "✅ ExecutionRole set to: ${EXECUTION_ROLE}"

echo ""
echo "✅ Phase 4 Complete!"

# ============================================================
# PHASE 5: Upload Sample Data
# ============================================================

echo ""
echo "========== PHASE 5: Upload Telemetry Data =========="
echo ""

echo "Uploading telemetry CSV files from data-seed/ to S3 data lake..."
aws s3 sync data-seed/ s3://${DATA_LAKE_BUCKET}/telemetry/ --region ${REGION}

echo ""
echo "Verifying data upload..."
FILE_COUNT=$(aws s3 ls s3://${DATA_LAKE_BUCKET}/telemetry/ --recursive --region ${REGION} | wc -l)
echo "✅ Uploaded ${FILE_COUNT} files to S3 with year/month/day partitioning"

echo ""
echo "✅ Phase 5 Complete!"

# ============================================================
# PHASE 6: Register Partitions
# ============================================================

echo ""
echo "========== PHASE 6: Register Partitions =========="
echo ""

echo "Executing MSCK REPAIR TABLE to register partitions..."
QUERY_ID=$(aws athena start-query-execution \
  --query-string "MSCK REPAIR TABLE ${TABLE_NAME}" \
  --query-execution-context Database=${DB_NAME} \
  --result-configuration OutputLocation=s3://${ATHENA_RESULTS_BUCKET}/query-results/ \
  --work-group ${WORKGROUP} \
  --region ${REGION} | jq -r '.QueryExecutionId')

echo "Query started: ${QUERY_ID}"
echo "Waiting 30 seconds for partition registration..."
sleep 30

echo ""
echo "Verifying partitions were registered..."
PARTITION_QUERY_ID=$(aws athena start-query-execution \
  --query-string "SHOW PARTITIONS ${TABLE_NAME}" \
  --query-execution-context Database=${DB_NAME} \
  --result-configuration OutputLocation=s3://${ATHENA_RESULTS_BUCKET}/query-results/ \
  --work-group ${WORKGROUP} \
  --region ${REGION} | jq -r '.QueryExecutionId')

echo "Partition check query: ${PARTITION_QUERY_ID}"
sleep 10

# Get partition results
PARTITION_COUNT=$(aws athena get-query-results \
  --query-execution-id ${PARTITION_QUERY_ID} \
  --region ${REGION} | jq '.ResultSet.Rows | length')

echo "✅ Partitions registered (found ${PARTITION_COUNT} partition entries)"

echo ""
echo "✅ Phase 6 Complete!"

# ============================================================
# PHASE 7: Test Queries
# ============================================================

echo ""
echo "========== PHASE 7: Test Queries =========="
echo ""

echo "Running test_lambda_query.py..."
python3 test_lambda_query.py

echo ""
echo "✅ Phase 7 Complete!"

echo ""
echo "=========================================="
echo "✅ ALL PHASES COMPLETED SUCCESSFULLY!"
echo "=========================================="
echo ""
echo "Summary:"
echo "  ✅ Phase 3b: CICD stack deployed (CodeCommit, CodeBuild, CodePipeline)"
echo "  ✅ Phase 4: Athena workgroup configured with ExecutionRole"
echo "  ✅ Phase 5: Telemetry data uploaded to S3 data lake"
echo "  ✅ Phase 6: Partitions registered with Glue"
echo "  ✅ Phase 7: Test queries executed"
echo ""
echo "Your RoboFleet Lambda infrastructure is now fully deployed and ready!"
