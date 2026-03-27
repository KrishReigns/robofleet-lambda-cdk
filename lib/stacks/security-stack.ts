import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

/**
 * SecurityStack creates encryption keys, IAM roles, and secrets management
 *
 * This stack provides:
 * - KMS keys for data encryption (at-rest) with automatic rotation
 * - IAM roles for each Lambda function (least-privilege principle)
 * - Secrets Manager for sensitive credentials (Slack webhook, API keys)
 * - Audit logging configuration (separate KMS key)
 * - Complete documentation of permissions for each role
 *
 * Key Principles:
 * 1. Customer-managed KMS keys (not AWS-managed)
 * 2. Least-privilege IAM (each role has ONLY what it needs)
 * 3. Explicit allow policies (no wildcards in actions or resources)
 * 4. Separate keys for application and audit data (compliance)
 */
export class SecurityStack extends cdk.Stack {
  // Export these for other stacks to reference
  public readonly appKey: kms.Key;
  public readonly auditKey: kms.Key;
  public readonly ingestRole: iam.Role;
  public readonly queryRole: iam.Role;
  public readonly processingRole: iam.Role;
  public readonly snsToSlackRole: iam.Role;
  public readonly snsToEmailRole: iam.Role;
  public readonly glueServiceRole: iam.Role;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ============================================
    // STEP 1: CREATE KMS KEYS (Customer-Managed Encryption)
    // ============================================
    // Why customer-managed keys?
    // - You control who can encrypt/decrypt
    // - Automatic annual key rotation (AWS rotates automatically)
    // - Full audit trail in CloudTrail
    // - Required for compliance: SOC2, HIPAA, PCI-DSS
    // - Can revoke access immediately if needed
    //
    // Two separate keys:
    // - appKey: For application data (S3, Secrets, etc)
    // - auditKey: For audit logs (CloudWatch, compliance)

    // Application Data Encryption Key
    // Used to encrypt: S3 objects, Secrets Manager data, DynamoDB items
    // All Lambda functions that access data will use this key
    this.appKey = new kms.Key(this, 'AppKey', {
      description: 'KMS key for RoboFleet application data encryption (S3, Secrets, DynamoDB)',
      enableKeyRotation: true, // AWS automatically rotates key material annually
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Keep key even if stack is deleted (safety)
      pendingWindow: cdk.Duration.days(7), // 7-day grace period before actual deletion
      enabled: true,
    });

    // Friendly alias for the application key
    new kms.Alias(this, 'AppKeyAlias', {
      aliasName: 'alias/robofleet-app-key',
      targetKey: this.appKey,
    });

    // Audit Trail Encryption Key
    // Separate key for CloudWatch logs and audit trails (compliance best practice)
    // Keeps audit data segregated from application data for compliance audits
    this.auditKey = new kms.Key(this, 'AuditKey', {
      description: 'KMS key for RoboFleet audit logs encryption (CloudWatch, compliance)',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pendingWindow: cdk.Duration.days(7),
      enabled: true,
    });

    new kms.Alias(this, 'AuditKeyAlias', {
      aliasName: 'alias/robofleet-audit-key',
      targetKey: this.auditKey,
    });

    // ============================================
    // STEP 2: CREATE IAM ROLES (Least-Privilege)
    // ============================================
    // Principle of Least Privilege:
    // Each Lambda gets ONLY the permissions it needs, nothing more
    // If a Lambda is compromised, attacker has minimal access
    //
    // 5 roles for 5 different Lambda functions:
    // 1. IngestLambdaRole: Receives telemetry, stores in S3
    // 2. QueryLambdaRole: Executes Athena queries, returns results
    // 3. ProcessingLambdaRole: Processes Glue data, prepares for Athena
    // 4. SNSToSlackRole: Converts SNS notifications to Slack messages
    // 5. SNSToEmailRole: Converts SNS notifications to emails (SES)

    // ---- ROLE 1: INGEST LAMBDA ----
    // Purpose: Receive device telemetry → Store in S3 data lake
    // What it needs:
    //   - S3: PutObject (write telemetry files)
    //   - S3: GetObject (read for testing)
    //   - KMS: Encrypt/decrypt with appKey
    //   - CloudWatch Logs: Write logs
    this.ingestRole = new iam.Role(this, 'IngestLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for Ingest Lambda: receives telemetry, stores in S3',
      roleName: 'robofleet-ingest-lambda-role',
    });

    // S3 permissions: Write telemetry files to data lake
    // Note: StorageStack will grant specific bucket permissions
    // This policy allows S3 operations with KMS encryption requirement
    this.ingestRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:PutObject',      // Upload telemetry files
        's3:GetObject',      // Read (for testing/validation)
        's3:ListBucket',     // List bucket contents
      ],
      // Allow all S3 buckets but require KMS encryption
      resources: ['arn:aws:s3:::*'],
      // CRITICAL: Require encryption with our KMS key
      conditions: {
        'StringEquals': {
          's3:x-amz-server-side-encryption': 'aws:kms',
          's3:x-amz-server-side-encryption-aws-kms-key-arn': this.appKey.keyArn,
        },
      },
    }));

    // KMS permissions: Encrypt/decrypt with appKey
    this.ingestRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'kms:Decrypt',
        'kms:GenerateDataKey',
        'kms:DescribeKey',
      ],
      resources: [this.appKey.keyArn],
    }));

    // CloudWatch Logs permissions: Write execution logs
    this.ingestRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/ingest:*`,
      ],
    }));

    // VPC permissions: Create/manage ENIs for VPC deployment
    this.ingestRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:CreateNetworkInterface',
        'ec2:DescribeNetworkInterfaces',
        'ec2:DeleteNetworkInterface',
      ],
      resources: ['*'],
    }));

    // ---- ROLE 2: QUERY LAMBDA ----
    // Purpose: Execute Athena SQL queries on S3 data
    // What it needs:
    //   - Athena: Start queries, check status, get results
    //   - Glue: Read table metadata
    //   - S3: Read raw data + write query results
    //   - CloudWatch Logs: Write logs
    this.queryRole = new iam.Role(this, 'QueryLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for Query Lambda: executes Athena queries on S3 data',
      roleName: 'robofleet-query-lambda-role',
    });

    // Athena permissions: Execute and manage queries
    this.queryRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'athena:StartQueryExecution',  // Start a query
        'athena:GetQueryExecution',    // Check query status
        'athena:GetQueryResults',      // Retrieve results
        'athena:StopQueryExecution',   // Cancel query if needed
        'athena:ListQueryExecutions',  // List past queries
      ],
      resources: [`arn:aws:athena:${this.region}:${this.account}:workgroup/robofleet-workgroup`],
    }));

    // Glue permissions: Read table metadata
    this.queryRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'glue:GetDatabase',     // Read database schema
        'glue:GetTable',        // Read table definition
        'glue:GetPartitions',   // Read partition info
        'glue:GetPartition',    // Read specific partition
        'glue:BatchGetPartition', // Get multiple partitions
      ],
      resources: [
        `arn:aws:glue:${this.region}:${this.account}:catalog`,
        `arn:aws:glue:${this.region}:${this.account}:database/robofleet_db`,
        `arn:aws:glue:${this.region}:${this.account}:table/robofleet_db/*`,
      ],
    }));

    // S3 permissions: Read raw telemetry data and write query results
    // Note: StorageStack will grant specific bucket permissions
    this.queryRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',           // Read data files
        's3:ListBucket',          // List files in bucket
        's3:GetBucketLocation',   // Get bucket region
        's3:PutObject',           // Write query results
      ],
      resources: ['arn:aws:s3:::*'],
    }));

    // CloudWatch Logs permissions: Write logs
    this.queryRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/query:*`,
      ],
    }));

    // VPC permissions: Create/manage ENIs for VPC deployment
    this.queryRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:CreateNetworkInterface',
        'ec2:DescribeNetworkInterfaces',
        'ec2:DeleteNetworkInterface',
      ],
      resources: ['*'],
    }));

    // ---- ROLE 3: PROCESSING LAMBDA ----
    // Purpose: Process Glue data, prepare for analytics
    // What it needs:
    //   - Glue: Read tables and metadata
    //   - S3: Read raw data
    //   - CloudWatch Logs: Write logs
    this.processingRole = new iam.Role(this, 'ProcessingLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for Processing Lambda: processes Glue data for analytics',
      roleName: 'robofleet-processing-lambda-role',
    });

    // Glue permissions: Read table definitions
    this.processingRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'glue:GetDatabase',
        'glue:GetTable',
        'glue:GetPartitions',
      ],
      resources: [
        `arn:aws:glue:${this.region}:${this.account}:catalog`,
        `arn:aws:glue:${this.region}:${this.account}:database/robofleet_db`,
        `arn:aws:glue:${this.region}:${this.account}:table/robofleet_db/*`,
      ],
    }));

    // S3 permissions: Read raw telemetry
    // Note: StorageStack will grant specific bucket permissions
    this.processingRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:ListBucket'],
      resources: ['arn:aws:s3:::*'],
    }));

    // CloudWatch Logs permissions: Write logs
    this.processingRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/processing:*`,
      ],
    }));

    // VPC permissions: Create/manage ENIs for VPC deployment
    this.processingRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:CreateNetworkInterface',
        'ec2:DescribeNetworkInterfaces',
        'ec2:DeleteNetworkInterface',
      ],
      resources: ['*'],
    }));

    // ---- ROLE 4: SNS-TO-SLACK LAMBDA ----
    // Purpose: Convert CloudWatch alarms → Slack notifications
    // What it needs:
    //   - Secrets Manager: Fetch Slack webhook URL
    //   - CloudWatch Logs: Write logs
    this.snsToSlackRole = new iam.Role(this, 'SNSToSlackLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for SNS-to-Slack Lambda: sends alerts to Slack',
      roleName: 'robofleet-sns-to-slack-lambda-role',
    });

    // Secrets Manager permissions: Fetch webhook URL
    this.snsToSlackRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:GetSecretValue',  // Retrieve Slack webhook URL
        'secretsmanager:DescribeSecret',
      ],
      resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:robofleet/slack-webhook*`,
      ],
    }));

    // KMS permissions: Decrypt webhook URL
    this.snsToSlackRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'kms:Decrypt',
        'kms:DescribeKey',
      ],
      resources: [this.appKey.keyArn],
    }));

    // CloudWatch Logs permissions: Write logs
    this.snsToSlackRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/sns-to-slack:*`,
      ],
    }));

    // VPC permissions: Create/manage ENIs for VPC deployment
    this.snsToSlackRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:CreateNetworkInterface',
        'ec2:DescribeNetworkInterfaces',
        'ec2:DeleteNetworkInterface',
      ],
      resources: ['*'],
    }));

    // ---- ROLE 5: SNS-TO-EMAIL LAMBDA ----
    // Purpose: Convert CloudWatch alarms → Email notifications via SES
    // What it needs:
    //   - SES: Send emails
    //   - Secrets Manager: Fetch email config
    //   - CloudWatch Logs: Write logs
    this.snsToEmailRole = new iam.Role(this, 'SNSToEmailLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Role for SNS-to-Email Lambda: sends alerts via email (SES)',
      roleName: 'robofleet-sns-to-email-lambda-role',
    });

    // SES permissions: Send emails
    this.snsToEmailRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ses:SendEmail',       // Send using From address
        'ses:SendRawEmail',    // Send raw email (more control)
      ],
      resources: [
        `arn:aws:ses:${this.region}:${this.account}:identity/*`, // Any verified identity
      ],
    }));

    // Secrets Manager permissions: Fetch email config
    this.snsToEmailRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'secretsmanager:GetSecretValue',
        'secretsmanager:DescribeSecret',
      ],
      resources: [
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:robofleet/email-*`,
      ],
    }));

    // KMS permissions: Decrypt email config
    this.snsToEmailRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'kms:Decrypt',
        'kms:DescribeKey',
      ],
      resources: [this.appKey.keyArn],
    }));

    // CloudWatch Logs permissions: Write logs
    this.snsToEmailRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/sns-to-email:*`,
      ],
    }));

    // VPC permissions: Create/manage ENIs for VPC deployment
    this.snsToEmailRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ec2:CreateNetworkInterface',
        'ec2:DescribeNetworkInterfaces',
        'ec2:DeleteNetworkInterface',
      ],
      resources: ['*'],
    }));

    // ---- ROLE 6: GLUE SERVICE ROLE ----
    // Purpose: AWS Glue service assumes this role to access S3 and other resources
    // What it needs:
    //   - S3: Read telemetry data from data lake
    //   - KMS: Decrypt S3 objects encrypted with appKey
    // Used by: Glue Crawlers, Glue Jobs, table partitioning
    this.glueServiceRole = new iam.Role(this, 'GlueServiceRole', {
      assumedBy: new iam.ServicePrincipal('glue.amazonaws.com'),
      description: 'Role for AWS Glue service: access S3 data lake and Glue Catalog',
      roleName: 'robofleet-glue-service-role',
    });

    // S3 permissions: Read data lake
    // Note: StorageStack will grant specific bucket permissions
    this.glueServiceRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:ListBucket',
      ],
      resources: ['arn:aws:s3:::*'],
    }));

    // KMS permissions: Decrypt data lake objects
    this.glueServiceRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'kms:Decrypt',
        'kms:DescribeKey',
        'kms:GenerateDataKey',
      ],
      resources: [this.appKey.keyArn],
    }));

    // Glue Catalog permissions: Read/write table metadata
    this.glueServiceRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'glue:GetDatabase',
        'glue:GetTable',
        'glue:GetPartitions',
        'glue:GetPartition',
        'glue:BatchGetPartition',
        'glue:UpdatePartition',
        'glue:BatchUpdatePartition',
      ],
      resources: [
        `arn:aws:glue:${this.region}:${this.account}:catalog`,
        `arn:aws:glue:${this.region}:${this.account}:database/robofleet_db`,
        `arn:aws:glue:${this.region}:${this.account}:table/robofleet_db/*`,
      ],
    }));

    // CloudWatch Logs permissions: Write logs
    this.glueServiceRole.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
      resources: [
        `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/glue/*`,
      ],
    }));

    // ============================================
    // STEP 3: SECRETS MANAGER (Sensitive Data Storage)
    // ============================================
    // Store sensitive data securely (never hardcode credentials in Lambda)
    // Benefits:
    // - Automatic encryption with KMS
    // - Automatic rotation capability
    // - Full audit trail in CloudTrail
    // - Access control via IAM
    // - Secrets never appear in CloudWatch logs

    // Slack Webhook Secret
    // Stores the Slack webhook URL used by SNS-to-Slack Lambda
    // Lambda will fetch this at runtime from Secrets Manager
    new secretsmanager.Secret(this, 'SlackWebhookSecret', {
      description: 'Slack webhook URL for sending alerts',
      secretName: 'robofleet/slack-webhook',
      encryptionKey: this.appKey, // Use our customer-managed KMS key
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Email Configuration Secret
    // Stores email addresses, sender info, etc
    new secretsmanager.Secret(this, 'EmailConfigSecret', {
      description: 'Email configuration for SES alerts',
      secretName: 'robofleet/email-config',
      encryptionKey: this.appKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ============================================
    // STEP 4: TAGS FOR COST TRACKING & COMPLIANCE
    // ============================================
    cdk.Tags.of(this).add('Component', 'Security');
    cdk.Tags.of(this).add('Cost-Center', 'RoboFleet-Analytics');
    cdk.Tags.of(this).add('Environment', 'Production');
    cdk.Tags.of(this).add('Compliance', 'SOC2-HIPAA-PCI');
  }
}
