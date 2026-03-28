# RoboFleet Lambda - Troubleshooting Guide

## Common Issues and Solutions

### CloudFormation Deployment Issues

#### Problem: "Resource of type 'AWS::IAM::Role' already exists"

**Cause:** SecurityStack tried to create a role that already exists in AWS from a previous deployment.

**Solution:**
- Code uses `iam.Role.fromRoleName()` to import existing roles instead of creating them
- If error still occurs, manually delete the stack: `aws cloudformation delete-stack --stack-name robofleet-security-stack`

#### Problem: "Stack is in UPDATE_ROLLBACK_COMPLETE state"

**Cause:** A previous deployment failed and rolled back, leaving the stack in a bad state.

**Solution:**
```bash
# Delete the failed stack
aws cloudformation delete-stack --stack-name <stack-name>

# Wait for deletion to complete
aws cloudformation describe-stacks --stack-name <stack-name>

# Redeploy
cdk deploy
```

#### Problem: "Cannot delete <stack> as it is in use by <other-stack>"

**Cause:** Trying to delete a stack that has exports used by dependent stacks.

**Solution:**
```bash
# Delete dependent stacks first (in reverse dependency order)
cdk destroy RobofleetComputeStack RobofleetStorageStack --force

# Then deploy fresh
cdk deploy --all
```

---

### Glue Table Issues

#### Problem: "Table device_telemetry not found" in queries

**Cause:** Glue table wasn't created or Athena is looking in wrong database.

**Solution:**
```bash
# Verify table exists
aws glue get-table --database-name robofleet_db --name device_telemetry --region us-east-1

# If not found, redeploy StorageStack
cdk deploy RobofleetStorageStack

# Verify table has correct columns (should see 6 columns)
aws glue get-table --database-name robofleet_db --name device_telemetry --region us-east-1 | jq '.Table.StorageDescriptor.Columns | length'
```

#### Problem: "COLUMN_NOT_FOUND: Column 'X' cannot be resolved"

**Cause:** Glue table schema doesn't match the query or CSV format.

**Expected columns:**
- device_id (string)
- temperature (double)
- humidity (double)
- pressure (double)
- timestamp (bigint or string)
- event_time (string)

**NOT expected** (these are wrong):
- fleet_id
- battery_level
- speed_mps
- status
- error_code
- location_zone
- temperature_celsius

**Solution:**
1. Check table definition: `aws glue get-table --database-name robofleet_db --name device_telemetry`
2. Check CSV format in S3: `aws s3 ls s3://robofleet-data-lake-235695894002/telemetry/ --recursive | head`
3. View sample CSV: `aws s3 cp s3://robofleet-data-lake-235695894002/telemetry/year=2026/month=03/day=20/device-ROBOT-0016-*.csv - | head -c 200`
4. If schema is wrong, redeploy StorageStack with correct column definitions

#### Problem: "Queries return 0 rows even though data exists in S3"

**Cause:** Partitions not registered in Glue metadata.

**Solution:**
```bash
# Register partitions
aws athena start-query-execution \
  --query-string "MSCK REPAIR TABLE device_telemetry" \
  --query-execution-context Database=robofleet_db \
  --result-configuration OutputLocation=s3://robofleet-athena-results-235695894002/query-results/ \
  --work-group robofleet-workgroup-v3 \
  --region us-east-1

# Wait 30 seconds, then verify partitions
aws athena start-query-execution \
  --query-string "SHOW PARTITIONS device_telemetry" \
  --query-execution-context Database=robofleet_db \
  --result-configuration OutputLocation=s3://robofleet-athena-results-235695894002/query-results/ \
  --work-group robofleet-workgroup-v3
```

---

### Athena Query Issues

#### Problem: "Not authorized to perform: athena:StartQueryExecution"

**Cause:** Athena workgroup doesn't have ExecutionRole set, or the role lacks required permissions.

**Solution:**
```bash
# Check if ExecutionRole is set
aws athena get-work-group --work-group robofleet-workgroup-v3 --region us-east-1 | jq '.WorkGroup.Configuration.ExecutionRole'

# If null or missing, set it
aws athena update-work-group \
  --work-group robofleet-workgroup-v3 \
  --configuration "ResultConfiguration={OutputLocation=s3://robofleet-athena-results-235695894002/query-results/,EncryptionConfiguration={EncryptionOption=SSE_S3}},ExecutionRole=arn:aws:iam::235695894002:role/robofleet-athena-service-role,EnforceWorkGroupConfiguration=true,PublishCloudWatchMetricsEnabled=true" \
  --region us-east-1
```

#### Problem: "User is not authorized to perform: s3:GetObject on resource"

**Cause:** ExecutionRole lacks S3 permissions on data lake bucket.

**Solution:**
Ensure ExecutionRole has these S3 permissions:
- `s3:GetObject` on data lake bucket (`robofleet-data-lake-*`)
- `s3:PutObject` on results bucket (`robofleet-athena-results-*`)
- `s3:ListBucket` on both buckets

Check policy:
```bash
aws iam get-role-policy --role-name robofleet-athena-service-role --policy-name S3Policy
```

#### Problem: "Query failed - Invalid data type"

**Cause:** Column type mismatch between Glue schema and actual CSV data.

**Solution:**
1. Verify CSV format: `aws s3 cp s3://...device-*.csv - | head -1`
2. Check Glue column types: `aws glue get-table --database-name robofleet_db --name device_telemetry | jq '.Table.StorageDescriptor.Columns'`
3. Update Glue table if types don't match (e.g., temperature should be 'double', not 'string')

---

### Lambda Function Issues

#### Problem: Lambda execution fails with timeout

**Cause:** VPC configuration, cold start, or long-running query.

**Solution:**
```bash
# Check Lambda timeout setting
aws lambda get-function-configuration --function-name robofleet-query | jq '.Timeout'

# Increase timeout if needed
aws lambda update-function-configuration \
  --function-name robofleet-query \
  --timeout 300  # 5 minutes
```

#### Problem: "AccessDenied: User is not authorized to perform Glue operations"

**Cause:** Lambda execution role lacks Glue permissions.

**Solution:**
Ensure Lambda role has:
- `glue:GetDatabase`
- `glue:GetTable`
- `glue:GetPartitions`
- `glue:BatchGetPartition`

Check in CloudFormation outputs or:
```bash
aws iam get-role-policy --role-name robofleet-query-lambda-role --policy-name GluePolicy
```

---

### S3 and Data Lake Issues

#### Problem: "Access Denied" when uploading to data lake

**Cause:** Ingest Lambda role doesn't have S3 put permissions.

**Solution:**
Check Ingest Lambda role has:
- `s3:PutObject` on data lake bucket
- `s3:ListBucket` on data lake bucket

#### Problem: "The CSV file format is invalid"

**Cause:** CSV has unexpected structure (extra columns, wrong delimiter, etc.)

**Solution:**
1. Inspect actual CSV: `aws s3 cp s3://robofleet-data-lake-*/telemetry/...device-*.csv - | hexdump -C | head -20`
2. Check for:
   - Correct delimiter (comma)
   - Correct number of fields (6)
   - No extra whitespace
   - No header row
   - No trailing newline

---

### Testing Issues

#### Problem: "test_lambda_query.py fails with ModuleNotFoundError"

**Solution:**
```bash
pip install boto3 --break-system-packages
python3 test_lambda_query.py
```

#### Problem: Test queries return empty results

**Cause:** Same as "Queries return 0 rows" - partitions not registered.

**Solution:** Run MSCK REPAIR TABLE (see above)

---

## Debugging Checklist

When something fails:

1. **Check CloudFormation events:**
   ```bash
   aws cloudformation describe-stack-events \
     --stack-name robofleet-storage-stack \
     --region us-east-1 | jq '.StackEvents[0:5]'
   ```

2. **Check Lambda logs:**
   ```bash
   aws logs tail /aws/lambda/robofleet-query --follow
   ```

3. **Check Athena query history:**
   ```bash
   aws athena list-query-executions --work-group robofleet-workgroup-v3
   ```

4. **Get query results:**
   ```bash
   aws athena get-query-results --query-execution-id <QUERY_ID>
   ```

5. **Verify IAM permissions:**
   ```bash
   # Check role exists
   aws iam get-role --role-name robofleet-athena-service-role

   # Check role policies
   aws iam list-role-policies --role-name robofleet-athena-service-role
   ```

6. **Test Athena connectivity:**
   ```bash
   aws athena start-query-execution \
     --query-string "SELECT 1" \
     --query-execution-context Database=robofleet_db \
     --result-configuration OutputLocation=s3://robofleet-athena-results-*/query-results/ \
     --work-group robofleet-workgroup-v3
   ```

---

## Data Validation

### Verify CSV Format

```bash
# Count fields in a CSV file
aws s3 cp s3://robofleet-data-lake-*/telemetry/year=2026/month=03/day=20/device-ROBOT-0016-*.csv - \
  | head -1 \
  | tr ',' '\n' \
  | wc -l

# Should output: 6
```

### Verify Partition Structure

```bash
# List all partitions in data lake
aws s3 ls s3://robofleet-data-lake-*/telemetry/ --recursive \
  | grep ".csv"

# Should show: year=YYYY/month=MM/day=DD/device-*.csv
```

---

## Contact & Support

For issues not covered here:
1. Check CloudFormation stack events
2. Review Lambda CloudWatch logs
3. Check Athena query history for SQL errors
4. Verify IAM role permissions in AWS console
