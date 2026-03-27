import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

interface StorageStackProps extends cdk.StackProps {
  appKey: kms.Key;
  glueServiceRole: iam.Role;
}

/**
 * StorageStack: Manages all data lake and query result storage infrastructure
 *
 * Components:
 * 1. S3 Data Lake (robofleet-data-lake): Stores raw device telemetry with 30-day intelligent tiering and 365-day expiration
 * 2. S3 Athena Results (robofleet-athena-results): Stores SQL query outputs with 30-day expiration
 * 3. Glue Database (robofleet_db): Metadata catalog for tables
 * 4. Glue External Table (device_telemetry): Partitioned device telemetry with 9 data columns + 3 partition keys
 *
 * Encryption: All S3 buckets encrypted with KMS appKey
 * Versioning: Enabled on data lake for data protection
 * Lifecycle: Intelligent-Tiering (30 days) and expiration (365 days) for cost optimization
 * Partitioning: year/month/day for efficient Athena queries
 */
export class StorageStack extends cdk.Stack {
  // Public exports for compute and CI/CD stacks
  public readonly dataLakeBucket: s3.Bucket;
  public readonly athenaResultsBucket: s3.Bucket;
  public readonly glueDatabaseName: string;
  public readonly deviceTelemetryTableName: string;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    const { appKey, glueServiceRole } = props;

    // ============================================================================
    // S3 DATA LAKE BUCKET - Primary storage for raw device telemetry
    // ============================================================================
    /**
     * Bucket: robofleet-data-lake
     * Purpose: Central repository for all device telemetry data
     * Partitioning: s3://robofleet-data-lake/telemetry/{year}/{month}/{day}/{hour}/data.csv
     * Encryption: KMS appKey (customer-managed, annual rotation)
     * Versioning: Enabled for data recovery and audit trail
     * Lifecycle:
     *   - Days 1-30: STANDARD (frequent access)
     *   - Days 31-365: INTELLIGENT_TIERING (auto-tiering based on access patterns)
     *   - Days 366+: EXPIRATION (automatic deletion)
     */
    this.dataLakeBucket = new s3.Bucket(this, 'DataLakeBucket', {
      bucketName: `robofleet-data-lake-${cdk.Stack.of(this).account}`,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: appKey,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          // Transition to Intelligent-Tiering after 30 days
          transitions: [
            {
              storageClass: s3.StorageClass.INTELLIGENT_TIERING,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
          // Expire objects after 365 days (1 year retention policy)
          expiration: cdk.Duration.days(365),
        },
      ],
      publicReadAccess: false,
    });

    // Deny unencrypted uploads
    this.dataLakeBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyUnencryptedObjectUploads',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:PutObject'],
        resources: [this.dataLakeBucket.arnForObjects('*')],
        conditions: {
          StringNotEquals: {
            's3:x-amz-server-side-encryption': 'aws:kms',
          },
        },
      })
    );

    // Deny non-KMS encrypted uploads
    this.dataLakeBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyNonKMSEncryptedUploads',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:PutObject'],
        resources: [this.dataLakeBucket.arnForObjects('*')],
        conditions: {
          StringNotEquals: {
            's3:x-amz-server-side-encryption-aws-kms-key-id': appKey.keyArn,
          },
        },
      })
    );

    // ============================================================================
    // S3 ATHENA RESULTS BUCKET - Storage for query output
    // ============================================================================
    /**
     * Bucket: robofleet-athena-results
     * Purpose: Stores Athena SQL query results and temporary query data
     * Encryption: KMS appKey (customer-managed, annual rotation)
     * Lifecycle: Auto-delete after 30 days (query results are temporary)
     * Access: Internal only, no public access
     */
    this.athenaResultsBucket = new s3.Bucket(this, 'AthenaResultsBucket', {
      bucketName: `robofleet-athena-results-${cdk.Stack.of(this).account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: appKey,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          // Expire query results after 30 days
          expiration: cdk.Duration.days(30),
        },
      ],
      publicReadAccess: false,
    });

    // Deny unencrypted uploads
    this.athenaResultsBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyUnencryptedObjectUploads',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:PutObject'],
        resources: [this.athenaResultsBucket.arnForObjects('*')],
        conditions: {
          StringNotEquals: {
            's3:x-amz-server-side-encryption': 'aws:kms',
          },
        },
      })
    );

    // ============================================================================
    // GLUE DATABASE - Metadata catalog
    // ============================================================================
    /**
     * Database: robofleet_db
     * Purpose: Logical grouping for all tables in the robofleet data lake
     * Tables: device_telemetry (primary table for device metrics)
     */
    this.glueDatabaseName = 'robofleet_db';

    const glueDatabase = new glue.CfnDatabase(this, 'GlueDatabase', {
      catalogId: cdk.Stack.of(this).account,
      databaseInput: {
        name: this.glueDatabaseName,
        description: 'Robofleet Lambda data lake metadata catalog',
      },
    });

    // ============================================================================
    // GLUE TABLE - Device telemetry external table
    // ============================================================================
    /**
     * Table: device_telemetry
     * Location: s3://robofleet-data-lake/telemetry/{year}/{month}/{day}/{hour}/
     * Format: CSV with LazySimpleSerDe (standard CSV parsing with lazy evaluation)
     * Columns: 9 data columns + 3 partition columns
     *
     * Data Columns (collected from IoT devices):
     *   - device_id (string): Unique identifier for each robotic device (e.g., 'ROBOT-001')
     *   - fleet_id (string): Fleet identifier grouping devices (e.g., 'WAREHOUSE-A')
     *   - event_time (string): ISO 8601 timestamp of telemetry event (e.g., '2025-03-27T14:30:45Z')
     *   - battery_level (double): Remaining battery percentage (0.0-100.0)
     *   - speed_mps (double): Current velocity in meters per second (0.0+)
     *   - status (string): Operational status (IDLE, MOVING, CHARGING, ERROR)
     *   - error_code (string): Error code if status=ERROR, null otherwise
     *   - location_zone (string): Current zone/warehouse location (e.g., 'ZONE-A-01')
     *   - temperature_celsius (double): Device temperature in Celsius
     *
     * Partition Columns (for efficient Athena partitioning):
     *   - year (string): Partition by year (e.g., '2025')
     *   - month (string): Partition by month zero-padded (e.g., '03')
     *   - day (string): Partition by day zero-padded (e.g., '27')
     */
    this.deviceTelemetryTableName = 'device_telemetry';

    const glueTable = new glue.CfnTable(this, 'DeviceTelemetryTable', {
      catalogId: cdk.Stack.of(this).account,
      databaseName: this.glueDatabaseName,
      tableInput: {
        name: this.deviceTelemetryTableName,
        description: 'Device telemetry data from IoT fleet',
        tableType: 'EXTERNAL_TABLE',
        parameters: {
          'classification': 'csv',
          'skip.header.line.count': '1',
        },
        storageDescriptor: {
          location: `s3://${this.dataLakeBucket.bucketName}/telemetry/`,
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe',
            parameters: {
              'field.delim': ',',
              'serialization.null.format': '',
            },
          },
          columns: [
            // Data columns (9 columns)
            {
              name: 'device_id',
              type: 'string',
              comment: 'Unique identifier for robotic device',
            },
            {
              name: 'fleet_id',
              type: 'string',
              comment: 'Fleet identifier grouping devices',
            },
            {
              name: 'event_time',
              type: 'string',
              comment: 'ISO 8601 timestamp of telemetry event',
            },
            {
              name: 'battery_level',
              type: 'double',
              comment: 'Battery percentage (0.0-100.0)',
            },
            {
              name: 'speed_mps',
              type: 'double',
              comment: 'Velocity in meters per second',
            },
            {
              name: 'status',
              type: 'string',
              comment: 'Device status (IDLE, MOVING, CHARGING, ERROR)',
            },
            {
              name: 'error_code',
              type: 'string',
              comment: 'Error code if status=ERROR, null otherwise',
            },
            {
              name: 'location_zone',
              type: 'string',
              comment: 'Current zone/warehouse location',
            },
            {
              name: 'temperature_celsius',
              type: 'double',
              comment: 'Device temperature in Celsius',
            },
          ],
        },
        partitionKeys: [
          // Partition columns (3 partition keys)
          {
            name: 'year',
            type: 'string',
            comment: 'Partition key: Year (YYYY)',
          },
          {
            name: 'month',
            type: 'string',
            comment: 'Partition key: Month (MM, zero-padded)',
          },
          {
            name: 'day',
            type: 'string',
            comment: 'Partition key: Day (DD, zero-padded)',
          },
        ],
      },
    });

    // Explicitly depend on database being created first
    glueTable.addDependency(glueDatabase);

    // ============================================================================
    // GLUE CATALOG PERMISSIONS - Already granted in SecurityStack
    // ============================================================================
    /**
     * NOTE: Permissions for glueServiceRole are already defined in SecurityStack:
     * - S3: wildcard read permissions (arn:aws:s3:::*) with KMS encryption requirement
     * - KMS: Decrypt, DescribeKey, GenerateDataKey on appKey
     *
     * We do NOT grant additional permissions here to avoid circular dependencies.
     * StorageStack depends on SecurityStack (for roles and keys), so StorageStack
     * should NOT modify SecurityStack resources back.
     */

    // ============================================================================
    // STACK OUTPUTS - Export for downstream stacks
    // ============================================================================
    new cdk.CfnOutput(this, 'DataLakeBucketName', {
      value: this.dataLakeBucket.bucketName,
      exportName: `${this.stackName}-DataLakeBucketName`,
      description: 'S3 bucket name for device telemetry data lake',
    });

    new cdk.CfnOutput(this, 'DataLakeBucketArn', {
      value: this.dataLakeBucket.bucketArn,
      exportName: `${this.stackName}-DataLakeBucketArn`,
      description: 'S3 bucket ARN for device telemetry data lake',
    });

    new cdk.CfnOutput(this, 'AthenaResultsBucketName', {
      value: this.athenaResultsBucket.bucketName,
      exportName: `${this.stackName}-AthenaResultsBucketName`,
      description: 'S3 bucket name for Athena query results',
    });

    new cdk.CfnOutput(this, 'AthenaResultsBucketArn', {
      value: this.athenaResultsBucket.bucketArn,
      exportName: `${this.stackName}-AthenaResultsBucketArn`,
      description: 'S3 bucket ARN for Athena query results',
    });

    new cdk.CfnOutput(this, 'GlueDatabaseName', {
      value: this.glueDatabaseName,
      exportName: `${this.stackName}-GlueDatabaseName`,
      description: 'Glue database name for metadata catalog',
    });

    new cdk.CfnOutput(this, 'DeviceTelemetryTableName', {
      value: this.deviceTelemetryTableName,
      exportName: `${this.stackName}-DeviceTelemetryTableName`,
      description: 'Glue table name for device telemetry',
    });
  }
}