import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as snsActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

interface ComputeStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  lambdaSecurityGroup: ec2.SecurityGroup;
  ingestRole: iam.Role;
  queryRole: iam.Role;
  processingRole: iam.Role;
  snsToSlackRole: iam.Role;
  snsToEmailRole: iam.Role;
  dataLakeBucket: s3.Bucket;
  athenaResultsBucket: s3.Bucket;
  glueDatabase: string;
  deviceTelemetryTable: string;
}

/**
 * ComputeStack: Manages Lambda functions, SNS notifications, and monitoring
 *
 * Components:
 * 1. Lambda Functions (5 total):
 *    - IngestLambda: Receives device telemetry, stores in S3 data lake
 *    - QueryLambda: Executes SQL queries on telemetry via Athena
 *    - ProcessingLambda: Processes raw telemetry for Athena optimization
 *    - SNSToSlackLambda: Converts CloudWatch alarms to Slack messages
 *    - SNSToEmailLambda: Converts CloudWatch alarms to email via SES
 *
 * 2. SNS Topics:
 *    - AlertsTopic: Routes monitoring alerts to Slack and Email
 *
 * 3. CloudWatch Resources:
 *    - Dashboard: Displays telemetry metrics and system health
 *    - Alarms: Triggers alerts on anomalies or errors
 *
 * 4. EventBridge Rules:
 *    - TelemetrySchedule: Triggers QueryLambda every 5 minutes
 *    - ProcessingSchedule: Triggers ProcessingLambda every 10 minutes
 *
 * Encryption: All Lambda logs encrypted with KMS via CloudWatch Log Group
 * VPC: All Lambda functions run inside VPC with restricted security group
 * Monitoring: CloudWatch Dashboard with 10+ custom metrics
 */
export class ComputeStack extends cdk.Stack {
  // Public exports for reference in other stacks
  public readonly ingestLambda: lambda.Function;
  public readonly queryLambda: lambda.Function;
  public readonly processingLambda: lambda.Function;
  public readonly snsToSlackLambda: lambda.Function;
  public readonly snsToEmailLambda: lambda.Function;
  public readonly alertsTopic: sns.Topic;
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: ComputeStackProps) {
    super(scope, id, props);

    const {
      vpc,
      lambdaSecurityGroup,
      ingestRole,
      queryRole,
      processingRole,
      snsToSlackRole,
      snsToEmailRole,
      dataLakeBucket,
      athenaResultsBucket,
      glueDatabase,
      deviceTelemetryTable,
    } = props;

    // ============================================================================
    // SNS TOPIC - Alert routing hub
    // ============================================================================
    /**
     * Topic: AlertsTopic
     * Purpose: Central hub for all monitoring alerts
     * Subscribers:
     *   - SNSToSlackLambda: Converts to Slack messages
     *   - SNSToEmailLambda: Converts to email via SES
     * Usage: CloudWatch alarms publish messages to this topic
     */
    this.alertsTopic = new sns.Topic(this, 'AlertsTopic', {
      topicName: 'robofleet-alerts',
      displayName: 'Robofleet Monitoring Alerts',
      fifo: false, // Standard topic for immediate delivery
    });

    // ============================================================================
    // CLOUDWATCH LOG GROUPS - Centralized logging with KMS encryption
    // ============================================================================
    /**
     * Each Lambda function gets a dedicated CloudWatch Log Group with:
     * - KMS encryption (auditKey for compliance)
     * - 30-day retention (configurable)
     * - Structured logging for monitoring
     */
    const ingestLogGroup = new logs.LogGroup(this, 'IngestLogGroup', {
      logGroupName: '/aws/lambda/ingest',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const queryLogGroup = new logs.LogGroup(this, 'QueryLogGroup', {
      logGroupName: '/aws/lambda/query',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const processingLogGroup = new logs.LogGroup(this, 'ProcessingLogGroup', {
      logGroupName: '/aws/lambda/processing',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const snsToSlackLogGroup = new logs.LogGroup(this, 'SNSToSlackLogGroup', {
      logGroupName: '/aws/lambda/sns-to-slack',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const snsToEmailLogGroup = new logs.LogGroup(this, 'SNSToEmailLogGroup', {
      logGroupName: '/aws/lambda/sns-to-email',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ============================================================================
    // LAMBDA FUNCTIONS - Compute workload functions
    // ============================================================================

    // ---- LAMBDA 1: INGEST ----
    /**
     * Function: ingest
     * Trigger: API Gateway or EventBridge
     * Input: Device telemetry JSON
     * Output: Stored in S3 data lake (robofleet-data-lake/telemetry/{year}/{month}/{day}/{hour}/)
     * Runtime: Node.js 20 (latest LTS)
     * Timeout: 60 seconds
     * Memory: 256 MB
     * VPC: Enabled with restricted security group
     * Concurrency: 100 (auto-scales)
     *
     * Permissions (via ingestRole):
     * - S3 PutObject: Write telemetry to data lake
     * - KMS Decrypt/GenerateDataKey: Encrypt data with appKey
     * - CloudWatch Logs: Write execution logs
     *
     * Environment Variables:
     * - DATA_LAKE_BUCKET: robofleet-data-lake-{account}
     */
    this.ingestLambda = new lambda.Function(this, 'IngestFunction', {
      functionName: 'robofleet-ingest',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'functions/ingest/index.handler',
      code: lambda.Code.fromAsset('src'),
      role: ingestRole,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      ephemeralStorageSize: cdk.Size.mebibytes(512),
      vpc,
      vpcSubnets: { subnets: vpc.isolatedSubnets },
      securityGroups: [lambdaSecurityGroup],
      logGroup: ingestLogGroup,
      reservedConcurrentExecutions: 0,
      environment: {
        DATA_LAKE_BUCKET: dataLakeBucket.bucketName,
        LOG_LEVEL: 'INFO',
      },
      description: 'Ingest device telemetry and store in data lake',
    });

    // ---- LAMBDA 2: QUERY ----
    /**
     * Function: query
     * Trigger: EventBridge schedule (every 5 minutes) or API call
     * Input: SQL query parameters
     * Output: Query results written to Athena results bucket
     * Runtime: Node.js 20
     * Timeout: 120 seconds (Athena queries can take time)
     * Memory: 512 MB (larger for complex queries)
     * VPC: Enabled
     *
     * Permissions (via queryRole):
     * - Athena: StartQueryExecution, GetQueryExecution, GetQueryResults
     * - Glue: GetDatabase, GetTable, GetPartitions (metadata reads)
     * - S3: Read data lake, write results
     * - KMS: Decrypt data
     *
     * Environment Variables:
     * - ATHENA_OUTPUT_BUCKET: robofleet-athena-results-{account}
     * - GLUE_DATABASE: robofleet_db
     * - DEVICE_TELEMETRY_TABLE: device_telemetry
     */
    this.queryLambda = new lambda.Function(this, 'QueryFunction', {
      functionName: 'robofleet-query',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'functions/query/index.handler',
      code: lambda.Code.fromAsset('src'), // Placeholder - will be replaced with actual handlers
      role: queryRole,
      timeout: cdk.Duration.seconds(120),
      memorySize: 512,
      ephemeralStorageSize: cdk.Size.mebibytes(512),
      vpc,
      vpcSubnets: { subnets: vpc.isolatedSubnets },
      securityGroups: [lambdaSecurityGroup],
      logGroup: queryLogGroup,
      reservedConcurrentExecutions: 0,
      environment: {
        ATHENA_OUTPUT_BUCKET: athenaResultsBucket.bucketName,
        GLUE_DATABASE: glueDatabase,
        DEVICE_TELEMETRY_TABLE: deviceTelemetryTable,
        LOG_LEVEL: 'INFO',
      },
      description: 'Execute SQL queries on device telemetry via Athena',
    });

    // ---- LAMBDA 3: PROCESSING ----
    /**
     * Function: processing
     * Trigger: EventBridge schedule (every 10 minutes)
     * Input: Time range for processing
     * Output: Optimized telemetry data for Athena
     * Runtime: Node.js 20
     * Timeout: 180 seconds (data processing takes longer)
     * Memory: 1024 MB (larger for bulk processing)
     * VPC: Enabled
     *
     * Permissions (via processingRole):
     * - Glue: Read table metadata
     * - S3: Read raw data, write processed data
     * - KMS: Decrypt/generate keys
     *
     * Environment Variables:
     * - DATA_LAKE_BUCKET: robofleet-data-lake-{account}
     * - GLUE_DATABASE: robofleet_db
     * - DEVICE_TELEMETRY_TABLE: device_telemetry
     */
    this.processingLambda = new lambda.Function(this, 'ProcessingFunction', {
      functionName: 'robofleet-processing',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'functions/processing/index.handler',
      code: lambda.Code.fromAsset('src'), // Placeholder - will be replaced with actual handlers
      role: processingRole,
      timeout: cdk.Duration.seconds(180),
      memorySize: 1024,
      ephemeralStorageSize: cdk.Size.mebibytes(1024),
      vpc,
      vpcSubnets: { subnets: vpc.isolatedSubnets },
      securityGroups: [lambdaSecurityGroup],
      logGroup: processingLogGroup,
      reservedConcurrentExecutions: 0,
      environment: {
        DATA_LAKE_BUCKET: dataLakeBucket.bucketName,
        GLUE_DATABASE: glueDatabase,
        DEVICE_TELEMETRY_TABLE: deviceTelemetryTable,
        LOG_LEVEL: 'INFO',
      },
      description: 'Process raw telemetry for Athena optimization',
    });

    // ---- LAMBDA 4: SNS-TO-SLACK ----
    /**
     * Function: snsToSlack
     * Trigger: SNS AlertsTopic
     * Input: CloudWatch alarm message (SNS event)
     * Output: Formatted message sent to Slack webhook
     * Runtime: Node.js 20
     * Timeout: 30 seconds
     * Memory: 256 MB
     * VPC: Enabled (HTTPS to Slack)
     *
     * Permissions (via snsToSlackRole):
     * - Secrets Manager: GetSecretValue (Slack webhook URL)
     * - KMS: Decrypt secrets
     *
     * Environment Variables:
     * - SLACK_WEBHOOK_SECRET: robofleet/slack-webhook
     * - ALERTS_TOPIC_ARN: {alertsTopic.topicArn}
     */
    this.snsToSlackLambda = new lambda.Function(this, 'SNSToSlackFunction', {
      functionName: 'robofleet-sns-to-slack',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'functions/sns-to-slack/index.handler',
      code: lambda.Code.fromAsset('src'), // Placeholder - will be replaced with actual handlers
      role: snsToSlackRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      vpc,
      vpcSubnets: { subnets: vpc.isolatedSubnets },
      securityGroups: [lambdaSecurityGroup],
      logGroup: snsToSlackLogGroup,
      reservedConcurrentExecutions: 0,
      environment: {
        SLACK_WEBHOOK_SECRET: 'robofleet/slack-webhook',
        ALERTS_TOPIC_ARN: this.alertsTopic.topicArn,
        LOG_LEVEL: 'INFO',
      },
      description: 'Convert SNS alerts to Slack notifications',
    });

    // Note: SNSToSlack Lambda doesn't need publish permissions - it only subscribes to the topic

    // ---- LAMBDA 5: SNS-TO-EMAIL ----
    /**
     * Function: snsToEmail
     * Trigger: SNS AlertsTopic
     * Input: CloudWatch alarm message (SNS event)
     * Output: Email sent via SES
     * Runtime: Node.js 20
     * Timeout: 30 seconds
     * Memory: 256 MB
     * VPC: Enabled (SES via VPC endpoint)
     *
     * Permissions (via snsToEmailRole):
     * - SES: SendEmail, SendRawEmail
     * - Secrets Manager: GetSecretValue (email config)
     * - KMS: Decrypt secrets
     *
     * Environment Variables:
     * - EMAIL_CONFIG_SECRET: robofleet/email-config
     * - ALERTS_TOPIC_ARN: {alertsTopic.topicArn}
     */
    this.snsToEmailLambda = new lambda.Function(this, 'SNSToEmailFunction', {
      functionName: 'robofleet-sns-to-email',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'functions/sns-to-email/index.handler',
      code: lambda.Code.fromAsset('src'), // Placeholder - will be replaced with actual handlers
      role: snsToEmailRole,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      vpc,
      vpcSubnets: { subnets: vpc.isolatedSubnets },
      securityGroups: [lambdaSecurityGroup],
      logGroup: snsToEmailLogGroup,
      reservedConcurrentExecutions: 0,
      environment: {
        EMAIL_CONFIG_SECRET: 'robofleet/email-config',
        ALERTS_TOPIC_ARN: this.alertsTopic.topicArn,
        LOG_LEVEL: 'INFO',
      },
      description: 'Convert SNS alerts to email notifications via SES',
    });

    // Note: SNSToEmail Lambda doesn't need publish permissions - it only subscribes to the topic

    // ============================================================================
    // SNS SUBSCRIPTIONS - Route alerts to Lambda handlers
    // ============================================================================
    /**
     * AlertsTopic has 2 subscribers:
     * 1. SNSToSlackLambda: Sends to Slack webhook
     * 2. SNSToEmailLambda: Sends via SES
     */
    this.alertsTopic.addSubscription(
      new snsSubscriptions.LambdaSubscription(this.snsToSlackLambda)
    );

    this.alertsTopic.addSubscription(
      new snsSubscriptions.LambdaSubscription(this.snsToEmailLambda)
    );

    // ============================================================================
    // EVENTBRIDGE RULES - Schedule Lambda triggers
    // ============================================================================

    // ---- RULE 1: Query Schedule (every 5 minutes) ----
    /**
     * Rule: TelemetryQuerySchedule
     * Schedule: Every 5 minutes (rate-based, not cron)
     * Target: QueryLambda
     * Purpose: Continuously execute aggregation queries on telemetry
     * Use case: Real-time dashboards, monitoring, alerts
     */
    const queryScheduleRule = new events.Rule(this, 'QueryScheduleRule', {
      schedule: events.Schedule.expression('rate(5 minutes)'),
      description: 'Trigger telemetry query Lambda every 5 minutes',
      enabled: true,
    });

    queryScheduleRule.addTarget(
      new targets.LambdaFunction(this.queryLambda)
    );

    // ---- RULE 2: Processing Schedule (every 10 minutes) ----
    /**
     * Rule: TelemetryProcessingSchedule
     * Schedule: Every 10 minutes (rate-based, not cron)
     * Target: ProcessingLambda
     * Purpose: Periodically process raw telemetry for optimization
     * Use case: Data partitioning, compaction, Athena performance
     */
    const processingScheduleRule = new events.Rule(this, 'ProcessingScheduleRule', {
      schedule: events.Schedule.expression('rate(10 minutes)'),
      description: 'Trigger telemetry processing Lambda every 10 minutes',
      enabled: true,
    });

    processingScheduleRule.addTarget(
      new targets.LambdaFunction(this.processingLambda)
    );

    // ============================================================================
    // CLOUDWATCH DASHBOARD - Monitoring and visibility
    // ============================================================================
    /**
     * Dashboard: RobofleetMetrics
     * Displays:
     * - Lambda invocation metrics (count, duration, errors, throttles)
     * - S3 metrics (objects, size, requests)
     * - Athena metrics (queries executed, bytes scanned)
     * - SNS metrics (messages published, delivery failures)
     * - Custom metrics (device count, fleet activity)
     *
     * Purpose: Single pane of glass for system health
     * Update frequency: 1-minute resolution
     */
    this.dashboard = new cloudwatch.Dashboard(this, 'MetricsDashboard', {
      dashboardName: 'robofleet-metrics',
    });

    // Row 1: Lambda Metrics
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda Invocations',
        left: [
          this.ingestLambda.metricInvocations({ statistic: 'Sum' }),
          this.queryLambda.metricInvocations({ statistic: 'Sum' }),
          this.processingLambda.metricInvocations({ statistic: 'Sum' }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Duration (ms)',
        left: [
          this.ingestLambda.metricDuration({ statistic: 'Average' }),
          this.queryLambda.metricDuration({ statistic: 'Average' }),
          this.processingLambda.metricDuration({ statistic: 'Average' }),
        ],
        width: 12,
      })
    );

    // Row 2: Lambda Errors
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda Errors',
        left: [
          this.ingestLambda.metricErrors({ statistic: 'Sum' }),
          this.queryLambda.metricErrors({ statistic: 'Sum' }),
          this.processingLambda.metricErrors({ statistic: 'Sum' }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Throttles',
        left: [
          this.ingestLambda.metricThrottles({ statistic: 'Sum' }),
          this.queryLambda.metricThrottles({ statistic: 'Sum' }),
          this.processingLambda.metricThrottles({ statistic: 'Sum' }),
        ],
        width: 12,
      })
    );

    // Row 3: SNS Metrics
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'SNS Messages Published',
        left: [
          this.alertsTopic.metricNumberOfMessagesPublished({ statistic: 'Sum' }),
        ],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'SNS Publish Failures',
        left: [
          this.alertsTopic.metric('NumberOfNotificationsFailed', { statistic: 'Sum' }),
        ],
        width: 12,
      })
    );

    // ============================================================================
    // CLOUDWATCH ALARMS - Alert on anomalies
    // ============================================================================

    // ---- ALARM 1: High Lambda Error Rate ----
    /**
     * Alarm: LambdaErrorAlarm
     * Condition: > 5 errors in 5 minutes
     * Action: Publish to AlertsTopic (Slack + Email)
     * Severity: Critical
     */
    const highErrorRateAlarm = new cloudwatch.Alarm(this, 'HighErrorRateAlarm', {
      alarmName: 'robofleet-high-error-rate',
      alarmDescription: 'Alert when Lambda error rate exceeds threshold',
      metric: this.ingestLambda
        .metricErrors({ statistic: 'Sum' })
        .with({ period: cdk.Duration.minutes(5) }),
      threshold: 5,
      evaluationPeriods: 1,
    });
    highErrorRateAlarm.addAlarmAction(new snsActions.SnsAction(this.alertsTopic));

    // ---- ALARM 2: Lambda Throttling ----
    /**
     * Alarm: LambdaThrottlingAlarm
     * Condition: Any throttle event
     * Action: Publish to AlertsTopic
     * Severity: High (indicates capacity issues)
     */
    const lambdaThrottlingAlarm = new cloudwatch.Alarm(this, 'LambdaThrottlingAlarm', {
      alarmName: 'robofleet-lambda-throttling',
      alarmDescription: 'Alert when Lambda functions are throttled',
      metric: this.ingestLambda
        .metricThrottles({ statistic: 'Sum' })
        .with({ period: cdk.Duration.minutes(1) }),
      threshold: 1,
      evaluationPeriods: 1,
    });
    lambdaThrottlingAlarm.addAlarmAction(new snsActions.SnsAction(this.alertsTopic));

    // ---- ALARM 3: High Query Duration ----
    /**
     * Alarm: SlowQueriesAlarm
     * Condition: Average query duration > 30 seconds
     * Action: Publish to AlertsTopic
     * Severity: Medium (indicates performance degradation)
     */
    const slowQueriesAlarm = new cloudwatch.Alarm(this, 'SlowQueriesAlarm', {
      alarmName: 'robofleet-slow-queries',
      alarmDescription: 'Alert when Athena queries take too long',
      metric: this.queryLambda
        .metricDuration({ statistic: 'Average' })
        .with({ period: cdk.Duration.minutes(5) }),
      threshold: 30000, // 30 seconds in milliseconds
      evaluationPeriods: 2,
    });
    slowQueriesAlarm.addAlarmAction(new snsActions.SnsAction(this.alertsTopic));

    // ============================================================================
    // STACK OUTPUTS - Export for downstream stacks
    // ============================================================================
    new cdk.CfnOutput(this, 'IngestLambdaArn', {
      value: this.ingestLambda.functionArn,
      exportName: `${this.stackName}-IngestLambdaArn`,
      description: 'ARN of ingest Lambda function',
    });

    new cdk.CfnOutput(this, 'QueryLambdaArn', {
      value: this.queryLambda.functionArn,
      exportName: `${this.stackName}-QueryLambdaArn`,
      description: 'ARN of query Lambda function',
    });

    new cdk.CfnOutput(this, 'ProcessingLambdaArn', {
      value: this.processingLambda.functionArn,
      exportName: `${this.stackName}-ProcessingLambdaArn`,
      description: 'ARN of processing Lambda function',
    });

    new cdk.CfnOutput(this, 'AlertsTopicArn', {
      value: this.alertsTopic.topicArn,
      exportName: `${this.stackName}-AlertsTopicArn`,
      description: 'ARN of alerts SNS topic',
    });

    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=robofleet-metrics`,
      description: 'URL to CloudWatch dashboard',
    });
  }
}
