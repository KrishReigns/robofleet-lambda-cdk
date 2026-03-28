#!/usr/bin/env python3
"""
Test the RoboFleet Query Lambda (Athena queries on ingested data)
"""

import json
import boto3
import time
import sys

athena_client = boto3.client('athena', region_name='us-east-1')

# Pre-defined queries matching actual telemetry schema
# Columns: device_id, fleet_id, event_time, battery_level, speed_mps, status, error_code, location_zone, temperature_celsius
QUERIES = {
    "device_telemetry_sample": """
        SELECT
            device_id,
            fleet_id,
            event_time,
            battery_level,
            speed_mps,
            temperature_celsius
        FROM device_telemetry
        WHERE year = '2026' AND month = '3'
        LIMIT 10
    """,

    "temperature_statistics": """
        SELECT
            device_id,
            fleet_id,
            CAST(AVG(temperature_celsius) AS DECIMAL(5,2)) as avg_temp,
            CAST(MIN(temperature_celsius) AS DECIMAL(5,2)) as min_temp,
            CAST(MAX(temperature_celsius) AS DECIMAL(5,2)) as max_temp,
            COUNT(*) as measurement_count
        FROM device_telemetry
        WHERE year = '2026' AND month = '3'
        GROUP BY device_id, fleet_id
        ORDER BY device_id
    """,

    "speed_and_battery_analysis": """
        SELECT
            device_id,
            status,
            CAST(AVG(speed_mps) AS DECIMAL(5,2)) as avg_speed,
            CAST(AVG(battery_level) AS DECIMAL(5,2)) as avg_battery,
            COUNT(*) as readings
        FROM device_telemetry
        WHERE year = '2026' AND month = '3'
        GROUP BY device_id, status
        ORDER BY avg_battery DESC
        LIMIT 10
    """,

    "device_status_report": """
        SELECT
            device_id,
            fleet_id,
            location_zone,
            status,
            error_code,
            event_time
        FROM device_telemetry
        WHERE year = '2026' AND month = '3' AND day = '20'
        ORDER BY event_time DESC
        LIMIT 20
    """
}

def execute_query(query_name, query_string):
    """Execute Athena query and wait for results"""
    
    print(f"\n{'─'*60}")
    print(f"Query: {query_name}")
    print(f"{'─'*60}\n")
    
    try:
        # Start query execution
        response = athena_client.start_query_execution(
            QueryString=query_string,
            QueryExecutionContext={'Database': 'robofleet_db'},
            ResultConfiguration={'OutputLocation': 's3://robofleet-athena-results-235695894002/query-results/'},
            WorkGroup='robofleet-workgroup-v3'
        )
        
        query_execution_id = response['QueryExecutionId']
        print(f"Query started: {query_execution_id}")
        
        # Poll for completion
        max_attempts = 30
        attempt = 0
        
        while attempt < max_attempts:
            execution = athena_client.get_query_execution(QueryExecutionId=query_execution_id)
            status = execution['QueryExecution']['Status']['State']
            
            if status == 'SUCCEEDED':
                print(f"✅ Query completed in {execution['QueryExecution']['Statistics']['EngineExecutionTimeInMillis']}ms")
                
                # Get results
                results = athena_client.get_query_results(QueryExecutionId=query_execution_id)
                rows = results['ResultSet']['Rows']
                
                print(f"\nResults ({len(rows)-1} data rows):\n")
                
                # Print header
                headers = [col['VarCharValue'] for col in rows[0]['Data']]
                print("  " + " | ".join(f"{h:20}" for h in headers[:5]))
                print("  " + "─" * 100)
                
                # Print data rows (limit to 10)
                for row in rows[1:11]:
                    cols = [cell.get('VarCharValue', 'NULL')[:20] for cell in row['Data'][:5]]
                    print("  " + " | ".join(f"{c:20}" for c in cols))
                
                if len(rows) > 11:
                    print(f"\n  ... and {len(rows)-11} more rows")
                
                return True
                
            elif status == 'FAILED':
                reason = execution['QueryExecution']['Status'].get('StateChangeReason', 'Unknown')
                print(f"❌ Query failed: {reason}")
                return False
            
            attempt += 1
            if attempt < max_attempts:
                print(f"⏳ Waiting... ({status})")
                time.sleep(2)
        
        print(f"❌ Query timeout after {max_attempts*2} seconds")
        return False
        
    except Exception as e:
        print(f"❌ Error: {e}")
        return False

def main():
    print("="*60)
    print("Testing RoboFleet Query Lambda (Athena)")
    print("="*60)
    
    results = {}
    
    for query_name, query_string in QUERIES.items():
        success = execute_query(query_name, query_string)
        results[query_name] = "✅" if success else "❌"
        time.sleep(1)  # Rate limiting
    
    # Summary
    print("\n" + "="*60)
    print("Query Summary")
    print("="*60)
    for query_name, status in results.items():
        print(f"{status} {query_name}")
    
    print("\n✅ Query testing completed!")

if __name__ == "__main__":
    main()
