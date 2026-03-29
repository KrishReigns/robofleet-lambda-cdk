#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { NetworkingStack } from '../lib/stacks/networking-stack';
import { SecurityStack } from '../lib/stacks/security-stack';
import { StorageStack } from '../lib/stacks/storage-stack';
import { ComputeStack } from '../lib/stacks/compute-stack';
import { CICDStack } from '../lib/stacks/cicd-stack';
import { QuickSightStack } from '../lib/stacks/quicksight-stack';

/**
 * Robofleet Lambda CDK Application
 *
 * Infrastructure deployment order:
 * 1. SecurityStack: KMS keys, IAM roles, Secrets Manager
 * 2. NetworkingStack: VPC, security groups, VPC endpoints (depends on SecurityStack for KMS)
 * 3. StorageStack: S3 buckets, Glue database/table (depends on SecurityStack for appKey + glueServiceRole)
 * 4. ComputeStack (next): Lambda functions (depends on all above)
 * 5. CICDStack (next): CodePipeline, CodeBuild (depends on all above)
 */

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

// Stack 1: Security - Create KMS keys, IAM roles, Secrets Manager
// This stack must be deployed first as it provides encryption keys and service roles
const securityStack = new SecurityStack(app, 'RobofleetSecurityStack', {
  env,
  description: 'Robofleet security infrastructure (KMS keys, IAM roles, Secrets Manager)',
  stackName: 'robofleet-security-stack',
});

// Stack 2: Networking - Create VPC, security groups, VPC endpoints
// Dependencies: SecurityStack (appKey for KMS-enabled VPC endpoints)
const networkingStack = new NetworkingStack(app, 'RobofleetNetworkingStack', {
  env,
  appKey: securityStack.appKey,
  description: 'Robofleet networking infrastructure (VPC, subnets, security groups, VPC endpoints)',
  stackName: 'robofleet-networking-stack',
});

// Explicit dependency: NetworkingStack depends on SecurityStack
networkingStack.addDependency(securityStack);

// Stack 3: Storage - Create S3 buckets, Glue database and table, Athena workgroup
// Dependencies: SecurityStack (appKey for S3 encryption, glueServiceRole, athenaServiceRole)
const storageStack = new StorageStack(app, 'RobofleetStorageStack', {
  env,
  appKey: securityStack.appKey,
  glueServiceRole: securityStack.glueServiceRole,
  athenaServiceRole: securityStack.athenaServiceRole,
  description: 'Robofleet data lake storage (S3 buckets, Glue database, tables, and Athena workgroup)',
  stackName: 'robofleet-storage-stack',
});

// Explicit dependency: StorageStack depends on SecurityStack
storageStack.addDependency(securityStack);

// Stack 4: Compute - Create Lambda functions, SNS topics, CloudWatch monitoring
// Dependencies: SecurityStack (execution roles, KMS key), NetworkingStack (VPC, security groups), StorageStack (S3 buckets, Glue database)
const computeStack = new ComputeStack(app, 'RobofleetComputeStack', {
  env,
  vpc: networkingStack.vpc,
  lambdaSecurityGroup: networkingStack.lambdaSecurityGroup,
  ingestRole: securityStack.ingestRole,
  queryRole: securityStack.queryRole,
  processingRole: securityStack.processingRole,
  snsToSlackRole: securityStack.snsToSlackRole,
  snsToEmailRole: securityStack.snsToEmailRole,
  kpiRole: securityStack.kpiRole,
  dataQualityRole: securityStack.dataQualityRole,
  dataLakeBucket: storageStack.dataLakeBucket,
  athenaResultsBucket: storageStack.athenaResultsBucket,
  glueDatabase: storageStack.glueDatabaseName,
  deviceTelemetryTable: storageStack.deviceTelemetryTableName,
  appKey: securityStack.appKey,
  description: 'Robofleet compute resources (Lambda functions, SNS, CloudWatch)',
  stackName: 'robofleet-compute-stack',
});

// Explicit dependencies
computeStack.addDependency(securityStack);
computeStack.addDependency(networkingStack);
computeStack.addDependency(storageStack);

// Stack 5: CI/CD - Create CodeCommit, CodeBuild, CodePipeline
// Dependencies: Only needs basic AWS setup (no specific stack dependencies)
const cicdStack = new CICDStack(app, 'RobofleetCICDStack', {
  env,
  description: 'Robofleet CI/CD pipeline (CodeCommit, CodeBuild, CodePipeline)',
  stackName: 'robofleet-cicd-stack',
});

// Stack 6: QuickSight — BI dashboards on top of Athena/Glue
// PREREQUISITE: QuickSight account must be activated manually in the console first
// Run after activation: npx cdk deploy RobofleetQuickSightStack
const quickSightStack = new QuickSightStack(app, 'RobofleetQuickSightStack', {
  env,
  quickSightUserArn: 'arn:aws:quicksight:us-east-1:235695894002:user/default/CloudAI',
  athenaWorkgroup: 'robofleet-workgroup-v3',
  athenaResultsBucketName: 'robofleet-athena-results-235695894002',
  glueDatabaseName: 'robofleet_db',
  appKey: securityStack.appKey,
  dataLakeBucket: storageStack.dataLakeBucket,
  athenaResultsBucket: storageStack.athenaResultsBucket,
  description: 'RoboFleet QuickSight data sources and datasets for BI dashboards',
  stackName: 'robofleet-quicksight-stack',
});

// QuickSight depends on storage (Glue views must exist) and compute (datasets reference workgroup)
quickSightStack.addDependency(storageStack);

app.synth();
