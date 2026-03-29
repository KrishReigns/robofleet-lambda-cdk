import * as cdk from 'aws-cdk-lib';
import * as quicksight from 'aws-cdk-lib/aws-quicksight';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * QuickSightStack — Business Intelligence Dashboards
 *
 * PURPOSE:
 *   Connects QuickSight to your Athena data lake so you can build
 *   interactive dashboards on top of the telemetry data in S3.
 *
 * WHY A SEPARATE STACK?
 *   QuickSight requires manual account activation before any CDK resources
 *   can be deployed (AWS requires a human to accept the billing agreement).
 *   Keeping it separate means the rest of the stacks deploy fine on a
 *   fresh account — you only deploy this stack after activation.
 *
 * WHAT THIS CREATES:
 *   1. DataSource  — Athena connection (workgroup + results bucket)
 *   2. DataSet     — fleet_daily_health view exposed to QuickSight
 *   3. DataSet     — device_status_summary view for device drill-down
 *
 * WHAT YOU DO IN THE CONSOLE (after deploying this stack):
 *   - Create an Analysis using these datasets
 *   - Add charts: bar chart (fleet error rate), line chart (battery trend),
 *     KPI widget (active device count)
 *   - Publish as a Dashboard to share with stakeholders
 *
 * TEACHING MOMENT — why CDK for DataSource/DataSet but console for Analysis?
 *   QuickSight Analyses require a full VisualDefinition JSON (100s of lines)
 *   describing every chart, color, field, and axis. Writing that by hand is
 *   impractical. The console has a drag-and-drop editor that generates this
 *   JSON for you. Once published, you CAN export dashboards to CDK via
 *   `aws quicksight describe-analysis` — but for initial creation, the
 *   console is the right tool.
 */

interface QuickSightStackProps extends cdk.StackProps {
  quickSightUserArn: string;        // arn:aws:quicksight:us-east-1:{account}:user/default/{username}
  athenaWorkgroup: string;          // robofleet-workgroup-v3
  athenaResultsBucketName: string;  // robofleet-athena-results-{account}
  glueDatabaseName: string;         // robofleet_db
  appKey: kms.Key;                  // KMS key for data lake encryption
  dataLakeBucket: s3.Bucket;        // robofleet-data-lake bucket
  athenaResultsBucket: s3.Bucket;   // robofleet-athena-results bucket
}

export class QuickSightStack extends cdk.Stack {
  public readonly dataSourceArn: string;

  constructor(scope: Construct, id: string, props: QuickSightStackProps) {
    super(scope, id, props);

    const {
      quickSightUserArn,
      athenaWorkgroup,
      athenaResultsBucketName,
      glueDatabaseName,
      appKey,
      dataLakeBucket,
      athenaResultsBucket,
    } = props;

    // =========================================================================
    // 0. GRANT QUICKSIGHT SERVICE ROLE ACCESS TO KMS + S3
    // =========================================================================
    /**
     * TEACHING MOMENT — why does QuickSight need these grants?
     *
     * When QuickSight creates a DataSource, it immediately runs a test Athena
     * query to verify the connection. That test query:
     *   1. Calls Athena API (already allowed via QuickSight's built-in policy)
     *   2. Athena tries to write results to robofleet-athena-results-* bucket
     *   3. That bucket uses SSE-KMS encryption (our appKey)
     *   4. QuickSight's service role needs kms:GenerateDataKey to write the file
     *
     * Without this, you get: "Unable to verify/create output bucket" — the same
     * error the Query Lambda hit before we added KMS grants to its role.
     *
     * QuickSight uses a fixed service role: aws-quicksight-service-role-v0
     * We import it (it already exists — created during QuickSight activation).
     */
    // Import the QuickSight service role with mutable: true (the default).
    // mutable: true means CDK WILL create an AWS::IAM::Policy in this stack
    // and attach it to the imported role — giving us proper CloudFormation
    // dependency ordering (policy created BEFORE DataSource connection test runs).
    //
    // Why mutable matters here:
    //   mutable: false → CDK only updates resource-based policies (S3, KMS key)
    //                    but skips creating an IAM Policy resource. No CloudFormation
    //                    dependency exists → DataSource runs before grants propagate.
    //   mutable: true  → CDK creates an AWS::IAM::Policy and attaches it to the role.
    //                    CloudFormation waits for the policy before creating DataSource.
    const quickSightServiceRole = iam.Role.fromRoleArn(
      this,
      'QuickSightServiceRole',
      `arn:aws:iam::${this.account}:role/service-role/aws-quicksight-service-role-v0`,
    );

    // KMS: decrypt data lake files + encrypt Athena result files
    appKey.grant(quickSightServiceRole,
      'kms:Decrypt',
      'kms:GenerateDataKey',
      'kms:DescribeKey',
    );

    // S3: read data lake + read/write results bucket
    // These also create CloudFormation-level dependencies in this stack
    dataLakeBucket.grantRead(quickSightServiceRole);
    athenaResultsBucket.grantReadWrite(quickSightServiceRole);

    // Glue: QuickSight needs to resolve column names from the Glue Catalog
    quickSightServiceRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'glue:GetDatabase',
        'glue:GetTable',
        'glue:GetPartitions',
        'glue:GetPartition',
        'glue:BatchGetPartition',
      ],
      resources: [
        `arn:aws:glue:${this.region}:${this.account}:catalog`,
        `arn:aws:glue:${this.region}:${this.account}:database/robofleet_db`,
        `arn:aws:glue:${this.region}:${this.account}:table/robofleet_db/*`,
      ],
    }));

    // Athena: workgroup-scoped access (same permissions as the Query Lambda)
    quickSightServiceRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'athena:StartQueryExecution',
        'athena:GetQueryExecution',
        'athena:GetQueryResults',
        'athena:StopQueryExecution',
        'athena:GetWorkGroup',
      ],
      resources: [
        `arn:aws:athena:${this.region}:${this.account}:workgroup/robofleet-workgroup*`,
      ],
    }));

    // Principal used in all QuickSight permission grants
    // QuickSight permissions are separate from IAM — they're QuickSight-internal ACLs
    const ownerPermissions = [
      {
        principal: quickSightUserArn,
        actions: [
          'quicksight:DescribeDataSource',
          'quicksight:DescribeDataSourcePermissions',
          'quicksight:PassDataSource',
          'quicksight:UpdateDataSource',
          'quicksight:DeleteDataSource',
          'quicksight:UpdateDataSourcePermissions',
        ],
      },
    ];

    const dataSetOwnerPermissions = [
      {
        principal: quickSightUserArn,
        actions: [
          'quicksight:DescribeDataSet',
          'quicksight:DescribeDataSetPermissions',
          'quicksight:PassDataSet',
          'quicksight:DescribeIngestion',
          'quicksight:ListIngestions',
          'quicksight:UpdateDataSet',
          'quicksight:DeleteDataSet',
          'quicksight:CreateIngestion',
          'quicksight:CancelIngestion',
          'quicksight:UpdateDataSetPermissions',
        ],
      },
    ];

    // =========================================================================
    // 1. DATA SOURCE — Athena connection
    // =========================================================================
    /**
     * TEACHING MOMENT — QuickSight DataSource vs DataSet
     *
     * DataSource = the CONNECTION (think: database server)
     *   → "Connect to Athena workgroup X, write results to bucket Y"
     *   → Created once, reused by many datasets
     *
     * DataSet = the QUERY/TABLE (think: specific view or SQL)
     *   → "From that Athena connection, run this SQL / use this table"
     *   → Each dataset maps to one table, view, or custom SQL
     *   → Has field-level transformations, calculated fields, row-level security
     *
     * DataSource ──1:many──▶ DataSet ──1:many──▶ Analysis ──▶ Dashboard
     */
    const dataSource = new quicksight.CfnDataSource(this, 'AthenaDataSource', {
      awsAccountId: this.account,
      dataSourceId: 'robofleet-athena-source',
      name: 'RoboFleet Athena',
      type: 'ATHENA',

      // Athena-specific config: which workgroup to use
      dataSourceParameters: {
        athenaParameters: {
          workGroup: athenaWorkgroup,
          // roleArn omitted — QuickSight uses its own service role
        },
      },

      // Where Athena writes result files before QuickSight reads them
      sslProperties: { disableSsl: false },

      permissions: ownerPermissions,
    });

    this.dataSourceArn = dataSource.attrArn;

    // =========================================================================
    // 2. DATASET: fleet_daily_health
    // =========================================================================
    /**
     * This dataset maps to the fleet_daily_health Athena VIEW.
     * QuickSight will query it via SPICE (in-memory cache) or direct query mode.
     *
     * TEACHING MOMENT — SPICE vs Direct Query
     *   SPICE = QuickSight's in-memory engine. Data is imported into QuickSight.
     *     Pros: Fast dashboard renders (sub-second), no Athena charges per render
     *     Cons: Refresh lag (you schedule refreshes), SPICE capacity limits
     *
     *   Direct Query = QuickSight runs Athena query on every dashboard load.
     *     Pros: Always fresh, no import lag
     *     Cons: Every user loading the dashboard = Athena query = cost
     *
     *   For a personal project with low traffic → DIRECT_QUERY is fine.
     *   For a production dashboard with 100 users → SPICE + hourly refresh.
     *
     * We use DIRECT_QUERY here. The importMode can be changed to SPICE later.
     */
    new quicksight.CfnDataSet(this, 'FleetDailyHealthDataSet', {
      awsAccountId: this.account,
      dataSetId: 'robofleet-fleet-daily-health',
      name: 'Fleet Daily Health',
      importMode: 'DIRECT_QUERY',

      physicalTableMap: {
        fleetDailyHealthTable: {
          relationalTable: {
            dataSourceArn: dataSource.attrArn,
            catalog: 'AwsDataCatalog',
            schema: glueDatabaseName,
            name: 'fleet_daily_health',  // Athena VIEW name
            inputColumns: [
              { name: 'year',                   type: 'STRING' },
              { name: 'month',                  type: 'STRING' },
              { name: 'day',                    type: 'STRING' },
              { name: 'fleet_id',               type: 'STRING' },
              { name: 'total_events',           type: 'INTEGER' },
              { name: 'active_devices',         type: 'INTEGER' },
              { name: 'error_count',            type: 'INTEGER' },
              { name: 'error_rate_pct',         type: 'DECIMAL' },
              { name: 'avg_battery_pct',        type: 'DECIMAL' },
              { name: 'critical_battery_events',type: 'INTEGER' },
              { name: 'min_battery_pct',        type: 'DECIMAL' },
              { name: 'avg_speed_mps',          type: 'DECIMAL' },
              { name: 'stalled_events',         type: 'INTEGER' },
              { name: 'avg_temp_celsius',       type: 'DECIMAL' },
              { name: 'max_temp_celsius',       type: 'DECIMAL' },
              { name: 'high_temp_events',       type: 'INTEGER' },
            ],
          },
        },
      },

      // LogicalTableMap: optional field renames and calculated fields
      // We add a calculated field: event_date = year + "-" + month + "-" + day
      // This makes date filtering in QuickSight much easier
      logicalTableMap: {
        fleetDailyHealthLogical: {
          alias: 'Fleet Daily Health',
          source: { physicalTableId: 'fleetDailyHealthTable' },
          dataTransforms: [
            {
              // Combine year/month/day into a single date string for time-series charts
              createColumnsOperation: {
                columns: [
                  {
                    columnName: 'event_date',
                    columnId: 'event_date_calc',
                    expression: "concat({year}, '-', {month}, '-', {day})",
                  },
                ],
              },
            },
          ],
        },
      },

      permissions: dataSetOwnerPermissions,
    });

    // =========================================================================
    // 3. DATASET: device_status_summary
    // =========================================================================
    new quicksight.CfnDataSet(this, 'DeviceStatusSummaryDataSet', {
      awsAccountId: this.account,
      dataSetId: 'robofleet-device-status-summary',
      name: 'Device Status Summary',
      importMode: 'DIRECT_QUERY',

      physicalTableMap: {
        deviceStatusTable: {
          relationalTable: {
            dataSourceArn: dataSource.attrArn,
            catalog: 'AwsDataCatalog',
            schema: glueDatabaseName,
            name: 'device_status_summary',
            inputColumns: [
              { name: 'year',             type: 'STRING' },
              { name: 'month',            type: 'STRING' },
              { name: 'day',              type: 'STRING' },
              { name: 'fleet_id',         type: 'STRING' },
              { name: 'device_id',        type: 'STRING' },
              { name: 'last_seen',        type: 'STRING' },
              { name: 'session_count',    type: 'INTEGER' },
              { name: 'error_count',      type: 'INTEGER' },
              { name: 'error_rate_pct',   type: 'DECIMAL' },
              { name: 'last_status',      type: 'STRING' },
              { name: 'avg_battery_pct',  type: 'DECIMAL' },
              { name: 'min_battery_pct',  type: 'DECIMAL' },
              { name: 'avg_temp_celsius', type: 'DECIMAL' },
              { name: 'max_temp_celsius', type: 'DECIMAL' },
              { name: 'avg_speed_mps',    type: 'DECIMAL' },
            ],
          },
        },
      },

      logicalTableMap: {
        deviceStatusLogical: {
          alias: 'Device Status Summary',
          source: { physicalTableId: 'deviceStatusTable' },
          dataTransforms: [
            {
              createColumnsOperation: {
                columns: [
                  {
                    columnName: 'event_date',
                    columnId: 'event_date_calc',
                    expression: "concat({year}, '-', {month}, '-', {day})",
                  },
                ],
              },
            },
          ],
        },
      },

      permissions: dataSetOwnerPermissions,
    });

    // =========================================================================
    // STACK OUTPUTS
    // =========================================================================
    new cdk.CfnOutput(this, 'QuickSightConsoleUrl', {
      value: `https://us-east-1.quicksight.aws.amazon.com/sn/start`,
      description: 'QuickSight console URL — create analyses from the datasets here',
    });

    new cdk.CfnOutput(this, 'DataSourceArn', {
      value: dataSource.attrArn,
      description: 'ARN of the Athena DataSource',
    });

    new cdk.CfnOutput(this, 'FleetHealthDataSetId', {
      value: 'robofleet-fleet-daily-health',
      description: 'Dataset ID for fleet_daily_health — use this to create analyses',
    });

    new cdk.CfnOutput(this, 'DeviceSummaryDataSetId', {
      value: 'robofleet-device-status-summary',
      description: 'Dataset ID for device_status_summary — use for device drill-down',
    });

    cdk.Tags.of(this).add('Component', 'Analytics');
    cdk.Tags.of(this).add('Cost-Center', 'RoboFleet-Analytics');
  }
}
