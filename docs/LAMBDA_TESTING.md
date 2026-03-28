# RoboFleet Lambda Functions - Testing Guide

## Overview
5 Lambda functions deployed and ready to test:
1. **robofleet-ingest** - Ingest CSV data into S3 data lake
2. **robofleet-query** - Query Athena for telemetry data
3. **robofleet-processing** - Process and aggregate telemetry
4. **robofleet-sns-to-slack** - Send alerts to Slack
5. **robofleet-sns-to-email** - Send alerts via email

---

## Test 1: Query Lambda (Athena Query)

**What it does**: Executes SQL queries against device_telemetry table

**Test command**:
```bash
aws lambda invoke \
  --function-name robofleet-query \
  --region us-east-1 \
  --payload '{
    "queryType": "device_telemetry_sample",
    "parameters": {
      "year": "2026",
      "month": "03"
    }
  }' \
  response.json

cat response.json | jq '.'
```

**Expected output**: Query results with device telemetry data

**Check logs**:
```bash
aws logs tail /aws/lambda/robofleet-query --follow --region us-east-1
```

---

## Test 2: Processing Lambda (Data Aggregation)

**What it does**: Aggregates telemetry data by device and time period

**Test command**:
```bash
aws lambda invoke \
  --function-name robofleet-processing \
  --region us-east-1 \
  --payload '{
    "action": "aggregate_by_device",
    "timeWindow": "daily",
    "year": "2026",
    "month": "03",
    "day": "20"
  }' \
  response.json

cat response.json | jq '.'
```

**Expected output**: Aggregated statistics per device

**Check logs**:
```bash
aws logs tail /aws/lambda/robofleet-processing --follow --region us-east-1
```

---

## Test 3: Ingest Lambda (CSV Upload)

**What it does**: Uploads CSV data to S3 data lake with KMS encryption

**Test command**:
```bash
# Create a test CSV file
cat > test_telemetry.csv << 'EOF'
device_id,fleet_id,event_time,battery_level,speed_mps,status,error_code,location_zone,temperature_celsius
ROBOT-0099,FLEET-TEST-01,2026-03-28 12:00:00,85,1.5,ACTIVE,,ZONE-A,22.5
ROBOT-0100,FLEET-TEST-01,2026-03-28 12:05:00,80,2.0,ACTIVE,,ZONE-B,23.0
EOF

# Encode as base64
ENCODED=$(base64 < test_telemetry.csv | tr -d '\n')

aws lambda invoke \
  --function-name robofleet-ingest \
  --region us-east-1 \
  --payload "{
    \"action\": \"upload_csv\",
    \"bucket\": \"robofleet-data-lake-235695894002\",
    \"key\": \"device-telemetry/year=2026/month=03/day=28/test_ingest.csv\",
    \"data\": \"$ENCODED\",
    \"encoding\": \"base64\"
  }" \
  response.json

cat response.json | jq '.'
```

**Expected output**: Success confirmation with S3 upload details

**Check logs**:
```bash
aws logs tail /aws/lambda/robofleet-ingest --follow --region us-east-1
```

---

## Test 4: SNS-to-Slack Lambda (Alerting)

**What it does**: Forwards SNS messages to Slack webhook

**Prerequisites**: Set up Slack webhook URL in Secrets Manager
```bash
aws secretsmanager create-secret \
  --name robofleet/slack-webhook-url \
  --secret-string "https://hooks.slack.com/services/YOUR/WEBHOOK/URL" \
  --region us-east-1
```

**Test command**:
```bash
# Publish test message to SNS topic
aws sns publish \
  --topic-arn arn:aws:sns:us-east-1:235695894002:robofleet-alerts \
  --subject "Test Alert" \
  --message "Temperature threshold exceeded: ROBOT-0018 at 45.2°C" \
  --region us-east-1
```

**Expected output**: Message appears in Slack channel

**Check logs**:
```bash
aws logs tail /aws/lambda/robofleet-sns-to-slack --follow --region us-east-1
```

---

## Test 5: SNS-to-Email Lambda (Email Alerts)

**What it does**: Sends SNS messages via SES email

**Prerequisites**: Verify email in SES
```bash
aws ses verify-email-identity \
  --email-address your-email@example.com \
  --region us-east-1
```

**Test command**:
```bash
# Publish test message to SNS
aws sns publish \
  --topic-arn arn:aws:sns:us-east-1:235695894002:robofleet-alerts \
  --subject "Battery Alert" \
  --message "Low battery detected: ROBOT-0015 at 15% charge" \
  --region us-east-1
```

**Expected output**: Email received at verified email address

**Check logs**:
```bash
aws logs tail /aws/lambda/robofleet-sns-to-email --follow --region us-east-1
```

---

## Test 6: Full Pipeline Test

**What it does**: Tests complete data flow from ingest → query → process → alert

**Commands**:
```bash
# 1. Ingest test data
echo "Step 1: Ingest test data..."
aws lambda invoke \
  --function-name robofleet-ingest \
  --region us-east-1 \
  --payload '{"action": "upload_csv"}' \
  /tmp/ingest_result.json

# 2. Query the data
echo "Step 2: Query ingested data..."
aws lambda invoke \
  --function-name robofleet-query \
  --region us-east-1 \
  --payload '{"queryType": "device_telemetry_sample"}' \
  /tmp/query_result.json

# 3. Process the data
echo "Step 3: Process data..."
aws lambda invoke \
  --function-name robofleet-processing \
  --region us-east-1 \
  --payload '{"action": "aggregate_by_device"}' \
  /tmp/process_result.json

# 4. Send alert
echo "Step 4: Send alert via SNS..."
aws sns publish \
  --topic-arn arn:aws:sns:us-east-1:235695894002:robofleet-alerts \
  --subject "Pipeline Test Alert" \
  --message "Full pipeline test completed successfully" \
  --region us-east-1

echo "Pipeline test complete!"
```

---

## Monitoring & Troubleshooting

**Check all Lambda logs**:
```bash
aws logs describe-log-groups --query 'logGroups[?contains(logGroupName, `/aws/lambda/robofleet`)]' --region us-east-1
```

**View specific Lambda metrics**:
```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name Duration \
  --dimensions Name=FunctionName,Value=robofleet-query \
  --start-time 2026-03-28T00:00:00Z \
  --end-time 2026-03-28T23:59:59Z \
  --period 3600 \
  --statistics Average,Maximum \
  --region us-east-1
```

**View errors**:
```bash
aws logs filter-log-events \
  --log-group-name /aws/lambda/robofleet-query \
  --filter-pattern "ERROR" \
  --region us-east-1
```

---

## Success Criteria

✅ **Query Lambda**: Returns telemetry data from Athena table
✅ **Processing Lambda**: Aggregates data by device
✅ **Ingest Lambda**: Successfully uploads CSV to S3
✅ **SNS-to-Slack**: Message appears in Slack (if configured)
✅ **SNS-to-Email**: Email received (if SES configured)
✅ **CloudWatch Logs**: No ERROR messages in logs
✅ **Full Pipeline**: Data flows end-to-end

---

## Next Steps After Testing

1. Integrate with real data sources
2. Set up CloudWatch alarms for Lambda errors
3. Configure SNS subscriptions for email/Slack
4. Create Lambda triggers (S3, EventBridge, API Gateway)
5. Deploy updates via CI/CD pipeline
