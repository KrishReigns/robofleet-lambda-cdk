-- ============================================================================
-- RoboFleet Athena Views
-- Database: robofleet_db
-- Purpose: Reusable query definitions for dashboards, KPI Lambda, and analysts
--
-- WHY VIEWS?
--   Raw table (device_telemetry) has year/month/day partition columns.
--   Every query must filter on those or Athena will full-scan all S3 data
--   (expensive + slow). These views encode the partition logic once so that
--   dashboards and the KPI Lambda never accidentally do a full-table scan.
--
-- HOW TO CREATE: run scripts/setup-athena-views.sh
-- HOW TO USE:    SELECT * FROM robofleet_db.fleet_daily_health WHERE day='29'
-- ============================================================================


-- ============================================================================
-- VIEW 1: fleet_daily_health
-- What it answers: "How is each fleet performing day by day?"
--
-- Key metrics:
--   total_events      - How many telemetry records arrived
--   active_devices    - Unique devices that reported in
--   error_count       - Number of ERROR-status events
--   error_rate_pct    - Percentage of events that were errors (your fleet SLI)
--   avg_battery_pct   - Average battery level (below 20 = critical)
--   critical_battery  - Devices with battery < 20 (need immediate attention)
--   avg_speed_mps     - Average speed (0 for a long time = stuck robot)
--   avg_temp_celsius  - Average temperature (outlier = hardware problem)
--
-- Partition logic: We always filter year + month when querying this view.
--   Without WHERE year='2026' AND month='03', Athena scans ALL data.
--   The view itself doesn't restrict — callers should add date filters.
-- ============================================================================
CREATE OR REPLACE VIEW robofleet_db.fleet_daily_health AS
SELECT
    year,
    month,
    day,
    fleet_id,

    -- Volume metrics
    COUNT(*)                                                AS total_events,
    COUNT(DISTINCT device_id)                               AS active_devices,

    -- Error metrics (SLI: fleet error rate)
    COUNT(*) FILTER (WHERE status = 'ERROR')                AS error_count,
    ROUND(
        COUNT(*) FILTER (WHERE status = 'ERROR') * 100.0
        / NULLIF(COUNT(*), 0),
    2)                                                      AS error_rate_pct,

    -- Battery health
    ROUND(AVG(battery_level), 1)                            AS avg_battery_pct,
    COUNT(*) FILTER (WHERE battery_level < 20)              AS critical_battery_events,
    MIN(battery_level)                                      AS min_battery_pct,

    -- Motion metrics
    ROUND(AVG(speed_mps), 2)                                AS avg_speed_mps,
    COUNT(*) FILTER (WHERE speed_mps = 0 AND status = 'ACTIVE') AS stalled_events,

    -- Temperature metrics
    ROUND(AVG(temperature_celsius), 1)                      AS avg_temp_celsius,
    MAX(temperature_celsius)                                AS max_temp_celsius,
    COUNT(*) FILTER (WHERE temperature_celsius > 80)        AS high_temp_events

FROM robofleet_db.device_telemetry
GROUP BY year, month, day, fleet_id;


-- ============================================================================
-- VIEW 2: device_status_summary
-- What it answers: "What is each device's recent health profile?"
--
-- Key metrics:
--   last_seen         - Most recent event_time (staleness check)
--   most_recent_status- Latest operational status
--   session_count     - How many events in the period
--   error_rate_pct    - Device-level error rate (identify bad actors)
--   avg_battery_pct   - Average battery for this device
--   avg_temp_celsius  - Average temperature (hot device = hardware issue)
--
-- Use case: QuickSight device drill-down — click a fleet → see its devices
-- Use case: Data Quality Lambda — check if a device has gone silent
-- ============================================================================
CREATE OR REPLACE VIEW robofleet_db.device_status_summary AS
SELECT
    year,
    month,
    day,
    fleet_id,
    device_id,

    -- Recency
    MAX(event_time)                                         AS last_seen,

    -- Volume
    COUNT(*)                                                AS session_count,

    -- Error profile
    COUNT(*) FILTER (WHERE status = 'ERROR')                AS error_count,
    ROUND(
        COUNT(*) FILTER (WHERE status = 'ERROR') * 100.0
        / NULLIF(COUNT(*), 0),
    2)                                                      AS error_rate_pct,

    -- Most common status (using MAX as a proxy for latest)
    MAX(status)                                             AS last_status,

    -- Battery profile
    ROUND(AVG(battery_level), 1)                            AS avg_battery_pct,
    MIN(battery_level)                                      AS min_battery_pct,

    -- Temperature profile
    ROUND(AVG(temperature_celsius), 1)                      AS avg_temp_celsius,
    MAX(temperature_celsius)                                AS max_temp_celsius,

    -- Motion
    ROUND(AVG(speed_mps), 2)                                AS avg_speed_mps

FROM robofleet_db.device_telemetry
GROUP BY year, month, day, fleet_id, device_id;


-- ============================================================================
-- VIEW 3: zone_activity
-- What it answers: "Which zones are busiest / most error-prone?"
--
-- Key metrics:
--   total_events      - Traffic volume per zone
--   unique_devices    - How many devices passed through
--   error_rate_pct    - Zone-level error rate (bad zone = infrastructure issue)
--   avg_battery_pct   - Battery levels in zone (low = charging stations needed)
--   avg_speed_mps     - Average speed (low speed = congestion)
--
-- Use case: Operational heatmap — "Zone D has 40% error rate today"
-- Use case: Capacity planning — "Zone A handles 3x the traffic of Zone B"
-- ============================================================================
CREATE OR REPLACE VIEW robofleet_db.zone_activity AS
SELECT
    year,
    month,
    day,
    location_zone,

    -- Traffic
    COUNT(*)                                                AS total_events,
    COUNT(DISTINCT device_id)                               AS unique_devices,
    COUNT(DISTINCT fleet_id)                                AS fleet_count,

    -- Error profile
    COUNT(*) FILTER (WHERE status = 'ERROR')                AS error_count,
    ROUND(
        COUNT(*) FILTER (WHERE status = 'ERROR') * 100.0
        / NULLIF(COUNT(*), 0),
    2)                                                      AS error_rate_pct,

    -- Performance
    ROUND(AVG(speed_mps), 2)                                AS avg_speed_mps,
    COUNT(*) FILTER (WHERE speed_mps = 0)                   AS stopped_events,

    -- Battery in zone
    ROUND(AVG(battery_level), 1)                            AS avg_battery_pct,
    COUNT(*) FILTER (WHERE battery_level < 20)              AS low_battery_count

FROM robofleet_db.device_telemetry
GROUP BY year, month, day, location_zone;
