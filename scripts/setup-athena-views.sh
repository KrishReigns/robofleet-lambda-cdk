#!/bin/bash
# ============================================================================
# Setup Athena Views for RoboFleet
#
# WHY A SCRIPT? Athena views cannot be created via CloudFormation/CDK directly.
# They live in the Glue Data Catalog and are created by running SQL in Athena.
# This script submits each CREATE VIEW statement and waits for confirmation.
#
# WHEN TO RUN:
#   - First time setup (after CDK deploy)
#   - After schema changes to device_telemetry (views may need updating)
#   - When adding new analytics requirements
# ============================================================================
set -e

REGION="us-east-1"
WORKGROUP="robofleet-workgroup-v3"
RESULTS_BUCKET="s3://robofleet-athena-results-235695894002/view-setup/"
DATABASE="robofleet_db"

echo "=================================================="
echo "Creating Athena Views for RoboFleet"
echo "  Region:    $REGION"
echo "  Workgroup: $WORKGROUP"
echo "  Database:  $DATABASE"
echo "=================================================="
echo ""

# Helper: run one SQL statement in Athena and wait for result
run_athena_query() {
    local DESCRIPTION="$1"
    local SQL="$2"

    echo "Creating: $DESCRIPTION..."

    EXEC_ID=$(aws athena start-query-execution \
        --query-string "$SQL" \
        --query-execution-context Database="$DATABASE" \
        --work-group "$WORKGROUP" \
        --region "$REGION" \
        --query 'QueryExecutionId' \
        --output text)

    # Poll until done (max 60 seconds)
    for i in $(seq 1 12); do
        sleep 5
        STATE=$(aws athena get-query-execution \
            --query-execution-id "$EXEC_ID" \
            --region "$REGION" \
            --query 'QueryExecution.Status.State' \
            --output text)

        if [ "$STATE" = "SUCCEEDED" ]; then
            echo "  ✅ $DESCRIPTION created (query: $EXEC_ID)"
            return 0
        elif [ "$STATE" = "FAILED" ] || [ "$STATE" = "CANCELLED" ]; then
            REASON=$(aws athena get-query-execution \
                --query-execution-id "$EXEC_ID" \
                --region "$REGION" \
                --query 'QueryExecution.Status.StateChangeReason' \
                --output text)
            echo "  ❌ FAILED: $REASON"
            exit 1
        fi
        echo "  ... waiting ($STATE)"
    done

    echo "  ❌ TIMEOUT after 60 seconds"
    exit 1
}

# ---- VIEW 1: fleet_daily_health ----
run_athena_query "fleet_daily_health" "
CREATE OR REPLACE VIEW robofleet_db.fleet_daily_health AS
SELECT
    year, month, day, fleet_id,
    COUNT(*) AS total_events,
    COUNT(DISTINCT device_id) AS active_devices,
    COUNT(*) FILTER (WHERE status = 'ERROR') AS error_count,
    ROUND(COUNT(*) FILTER (WHERE status = 'ERROR') * 100.0 / NULLIF(COUNT(*), 0), 2) AS error_rate_pct,
    ROUND(AVG(battery_level), 1) AS avg_battery_pct,
    COUNT(*) FILTER (WHERE battery_level < 20) AS critical_battery_events,
    MIN(battery_level) AS min_battery_pct,
    ROUND(AVG(speed_mps), 2) AS avg_speed_mps,
    COUNT(*) FILTER (WHERE speed_mps = 0 AND status = 'ACTIVE') AS stalled_events,
    ROUND(AVG(temperature_celsius), 1) AS avg_temp_celsius,
    MAX(temperature_celsius) AS max_temp_celsius,
    COUNT(*) FILTER (WHERE temperature_celsius > 80) AS high_temp_events
FROM robofleet_db.device_telemetry
GROUP BY year, month, day, fleet_id
"

# ---- VIEW 2: device_status_summary ----
run_athena_query "device_status_summary" "
CREATE OR REPLACE VIEW robofleet_db.device_status_summary AS
SELECT
    year, month, day, fleet_id, device_id,
    MAX(event_time) AS last_seen,
    COUNT(*) AS session_count,
    COUNT(*) FILTER (WHERE status = 'ERROR') AS error_count,
    ROUND(COUNT(*) FILTER (WHERE status = 'ERROR') * 100.0 / NULLIF(COUNT(*), 0), 2) AS error_rate_pct,
    MAX(status) AS last_status,
    ROUND(AVG(battery_level), 1) AS avg_battery_pct,
    MIN(battery_level) AS min_battery_pct,
    ROUND(AVG(temperature_celsius), 1) AS avg_temp_celsius,
    MAX(temperature_celsius) AS max_temp_celsius,
    ROUND(AVG(speed_mps), 2) AS avg_speed_mps
FROM robofleet_db.device_telemetry
GROUP BY year, month, day, fleet_id, device_id
"

# ---- VIEW 3: zone_activity ----
run_athena_query "zone_activity" "
CREATE OR REPLACE VIEW robofleet_db.zone_activity AS
SELECT
    year, month, day, location_zone,
    COUNT(*) AS total_events,
    COUNT(DISTINCT device_id) AS unique_devices,
    COUNT(DISTINCT fleet_id) AS fleet_count,
    COUNT(*) FILTER (WHERE status = 'ERROR') AS error_count,
    ROUND(COUNT(*) FILTER (WHERE status = 'ERROR') * 100.0 / NULLIF(COUNT(*), 0), 2) AS error_rate_pct,
    ROUND(AVG(speed_mps), 2) AS avg_speed_mps,
    COUNT(*) FILTER (WHERE speed_mps = 0) AS stopped_events,
    ROUND(AVG(battery_level), 1) AS avg_battery_pct,
    COUNT(*) FILTER (WHERE battery_level < 20) AS low_battery_count
FROM robofleet_db.device_telemetry
GROUP BY year, month, day, location_zone
"

echo ""
echo "=================================================="
echo "✅ All Athena Views Created Successfully"
echo ""
echo "Test with:"
echo "  aws athena start-query-execution \\"
echo "    --query-string \"SELECT * FROM fleet_daily_health WHERE year='2026' AND month='03'\" \\"
echo "    --query-execution-context Database=robofleet_db \\"
echo "    --work-group robofleet-workgroup-v3 --region us-east-1"
echo "=================================================="
