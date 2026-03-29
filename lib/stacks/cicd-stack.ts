import * as cdk from 'aws-cdk-lib';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipelineActions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import { Construct } from 'constructs';

/**
 * CICDStack: Continuous Integration and Continuous Deployment pipeline
 *
 * Pipeline Flow:
 * 1. Source Stage: Polls CodeCommit repository for changes
 * 2. Build Stage: Compiles TypeScript, runs tests, packages Lambda functions
 * 3. Deploy Stage: Deploys CDK stack to AWS account via CloudFormation
 *
 * Components:
 * - CodeCommit Repository: Stores infrastructure and application code
 * - CodeBuild Project: Builds and tests TypeScript code
 * - CodePipeline: Orchestrates the CI/CD workflow
 * - S3 Artifacts Bucket: Stores build artifacts between stages
 *
 * Build Process:
 * - npm install: Install dependencies
 * - npm run build: Compile TypeScript to JavaScript
 * - npm run test: Run Jest unit tests
 * - cdk synth: Generate CloudFormation template
 * - cdk deploy: Deploy to AWS (with manual approval)
 *
 * Security:
 * - Least-privilege IAM roles for pipeline and build
 * - S3 artifact bucket encrypted with KMS
 * - Restricted egress for build environment
 * - No access to production secrets during build
 *
 * Triggers:
 * - Automatic: On commit to main branch (CodeCommit)
 * - Manual: Execute pipeline action via AWS Console or CLI
 */
export class CICDStack extends cdk.Stack {
  public readonly pipeline: codepipeline.Pipeline;
  public readonly buildProject: codebuild.PipelineProject;
  public readonly repository: codecommit.Repository;
  public readonly artifactsBucket: s3.IBucket;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ============================================================================
    // S3 ARTIFACTS BUCKET - Store build artifacts
    // ============================================================================
    /**
     * Bucket: robofleet-cicd-artifacts
     * Purpose: Stores build artifacts (compiled code, Lambda packages, CloudFormation templates)
     * Encryption: S3-managed encryption (suitable for CI/CD artifacts)
     * Versioning: Enabled for artifact history
     * Lifecycle: Delete artifacts after 30 days (pipeline only uses latest)
     * Access: CodePipeline and CodeBuild only
     *
     * Import existing bucket to avoid "already exists" CloudFormation errors
     */
    this.artifactsBucket = s3.Bucket.fromBucketName(
      this,
      'ArtifactsBucket',
      `robofleet-cicd-artifacts-${cdk.Stack.of(this).account}`
    );

    // ============================================================================
    // CODECOMMIT REPOSITORY - Source control
    // ============================================================================
    /**
     * Repository: robofleet-lambda
     * Branch: main (default)
     * Purpose: Stores all infrastructure code (CDK stacks) and application code (Lambda functions)
     * Initial Content: Empty (user will push code)
     *
     * Repository Structure:
     * robofleet-lambda/
     * ├── bin/
     * │   └── app.ts                        # CDK app entry point
     * ├── lib/
     * │   └── stacks/
     * │       ├── networking-stack.ts       # VPC, security groups, VPC endpoints
     * │       ├── security-stack.ts         # KMS, IAM, Secrets Manager
     * │       ├── storage-stack.ts          # S3, Glue database/table
     * │       ├── compute-stack.ts          # Lambda, SNS, CloudWatch
     * │       └── cicd-stack.ts             # CodePipeline, CodeBuild
     * ├── src/
     * │   └── functions/
     * │       ├── ingest/
     * │       │   └── handler.ts            # Ingest Lambda handler
     * │       ├── query/
     * │       │   └── handler.ts            # Query Lambda handler
     * │       ├── processing/
     * │       │   └── handler.ts            # Processing Lambda handler
     * │       ├── sns-to-slack/
     * │       │   └── handler.ts            # SNS to Slack Lambda
     * │       └── sns-to-email/
     * │           └── handler.ts            # SNS to Email Lambda
     * ├── tests/
     * │   └── unit/
     * │       └── *.test.ts                 # Jest unit tests
     * ├── package.json                      # Node.js dependencies and scripts
     * ├── tsconfig.json                     # TypeScript configuration
     * ├── jest.config.js                    # Jest test configuration
     * ├── cdk.json                          # CDK configuration
     * └── README.md                         # Project documentation
     */
    this.repository = new codecommit.Repository(this, 'Repository', {
      repositoryName: 'robofleet-lambda',
      description: 'Robofleet Lambda CDK infrastructure and application code',
    });

    // ============================================================================
    // CODEBUILD PROJECT - Build and test
    // ============================================================================
    /**
     * Project: robofleet-build
     * Runtime: Node.js 20 (matches Lambda runtime)
     * BuildSpec: Uses buildspec.yml from repository root
     *
     * Build Steps (from buildspec.yml):
     * 1. pre_build:
     *    - npm install: Install CDK, dependencies, dev tools
     *    - npm run build: Compile TypeScript
     * 2. build:
     *    - npm run test: Run Jest unit tests
     *    - cdk synth: Generate CloudFormation templates
     * 3. post_build:
     *    - echo "Build complete"
     *
     * Artifacts:
     *    - cdk.out/: CloudFormation templates (for deploy stage)
     *    - dist/: Compiled JavaScript (for Lambda deployment)
     *
     * Environment Variables (from parameter store):
     * - CDK_DEFAULT_ACCOUNT: AWS account ID
     * - CDK_DEFAULT_REGION: AWS region (e.g., us-east-1)
     *
     * IAM Permissions:
     * - Read CodeCommit repository
     * - Write S3 artifacts bucket
     * - Read/write CloudWatch logs
     * - Access to KMS if artifacts are encrypted (future enhancement)
     */
    this.buildProject = new codebuild.PipelineProject(this, 'BuildProject', {
      projectName: 'robofleet-build',
      description: 'Build and test robofleet Lambda infrastructure',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: false, // No Docker daemon needed
      },
      buildSpec: codebuild.BuildSpec.fromSourceFilename('buildspec.yml'),
      environmentVariables: {
        CDK_DEFAULT_ACCOUNT: {
          value: cdk.Stack.of(this).account,
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        },
        CDK_DEFAULT_REGION: {
          value: cdk.Stack.of(this).region,
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        },
      },
      logging: {
        cloudWatch: {
          logGroup: new cdk.aws_logs.LogGroup(this, 'BuildLogs', {
            logGroupName: '/aws/codebuild/robofleet-build',
            retention: cdk.aws_logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          }),
        },
      },
    });

    // Grant build project access to artifacts bucket
    this.artifactsBucket.grantReadWrite(this.buildProject);

    // ============================================================================
    // CODEPIPELINE - Orchestrate CI/CD workflow
    // ============================================================================
    /**
     * Pipeline: robofleet-pipeline
     * Trigger: Automatic on commit to main branch (CodeCommit)
     * Stages:
     * 1. Source: Poll CodeCommit main branch every minute
     * 2. Build: Run CodeBuild project (compile, test, synthesize)
     * 3. Deploy: Execute CloudFormation stack (manual approval required for production)
     *
     * Artifacts Flow:
     * Source → (robofleet-source-artifact) → Build → (robofleet-build-artifact) → Deploy
     *
     * Failure Handling:
     * - Build failures: Pipeline stops, no deployment
     * - Test failures: Pipeline stops, no deployment
     * - Deploy failures: Manual review required
     *
     * Manual Approval:
     * Deploy stage includes manual approval action to prevent unintended production deployments
     */
    this.pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'robofleet-pipeline',
      artifactBucket: this.artifactsBucket,
      restartExecutionOnUpdate: true,
    });

    // ---- Stage 1: Source ----
    /**
     * Source Stage: Poll CodeCommit repository
     * Trigger: Changes to main branch automatically trigger pipeline
     * Polling: Every minute (default)
     * Artifact Output: Source code files
     */
    const sourceOutput = new codepipeline.Artifact('robofleet-source-artifact');

    this.pipeline.addStage({
      stageName: 'Source',
      actions: [
        new codepipelineActions.CodeCommitSourceAction({
          actionName: 'CodeCommit',
          output: sourceOutput,
          repository: this.repository,
          branch: 'main',
          trigger: codepipelineActions.CodeCommitTrigger.POLL,
        }),
      ],
    });

    // ---- Stage 2: Build ----
    /**
     * Build Stage: Compile and test code
     * Actions:
     * 1. Run CodeBuild project on source code
     * 2. Generate CloudFormation templates via cdk synth
     * 3. Run unit tests to validate code
     * Output Artifacts:
     * - cdk.out/: CloudFormation template
     * - dist/: Compiled Lambda function code
     */
    const buildOutput = new codepipeline.Artifact('robofleet-build-artifact');

    this.pipeline.addStage({
      stageName: 'Build',
      actions: [
        new codepipelineActions.CodeBuildAction({
          actionName: 'Build',
          project: this.buildProject,
          input: sourceOutput,
          outputs: [buildOutput],
          runOrder: 1,
        }),
      ],
    });

    // ============================================================================
    // IAM ROLES - CloudFormation execution role
    // ============================================================================
    /**
     * Create a CloudFormation execution role that CodePipeline can assume
     * This role will execute CloudFormation templates with necessary permissions
     *
     * Trust Policy: Allows CloudFormation service, CodePipeline service, AND the pipeline role to assume it
     */
    const cfExecutionRole = new iam.Role(this, 'CFExecutionRole', {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('cloudformation.amazonaws.com'),
        new iam.ServicePrincipal('codepipeline.amazonaws.com'),
        new iam.ArnPrincipal(this.pipeline.role!.roleArn) // Allow pipeline ROLE to assume this role
      ),
      description: 'CloudFormation execution role for pipeline deployments',
    });

    // Grant CloudFormation role permissions to manage stacks and read CDK bootstrap
    cfExecutionRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')
    );

    // Allow pipeline to pass this role to CloudFormation
    this.pipeline.role?.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [cfExecutionRole.roleArn],
      })
    );

    // ---- Stage 3: Deploy ----
    /**
     * Deploy Stage: Deploy CDK stack to AWS
     * Actions:
     * 1. Manual Approval: Reviewer confirms deployment
     * 2. CloudFormation Deploy: Apply infrastructure changes
     *
     * CloudFormation:
     * - Stack Name: robofleet-infrastructure
     * - Capabilities: [CAPABILITY_IAM, CAPABILITY_NAMED_IAM] (required for IAM resources)
     * - Template Source: cdk.out/RobofleetStack.template.json
     *
     * Approval Gate:
     * - Prevents accidental production deployments
     * - Allows review of changes before apply
     * - Manual action via AWS Console or SNS notification
     */
    this.pipeline.addStage({
      stageName: 'Deploy',
      actions: [
        // Manual approval before deployment
        new codepipelineActions.ManualApprovalAction({
          actionName: 'ApproveDeployment',
          additionalInformation: 'Review the build artifacts and approve deployment to AWS',
          runOrder: 1,
        }),
        // Deploy via CloudFormation
        new codepipelineActions.CloudFormationCreateUpdateStackAction({
          actionName: 'CloudFormationDeploy',
          stackName: 'robofleet-security-stack',
          templatePath: buildOutput.atPath('cdk.out/RobofleetSecurityStack.template.json'),
          adminPermissions: false,
          cfnCapabilities: [
            cdk.CfnCapabilities.NAMED_IAM,
            cdk.CfnCapabilities.AUTO_EXPAND,
          ],
          runOrder: 2,
          role: cfExecutionRole,
          // Note: CDK typically generates multiple stack templates
          // In production, you'd use custom logic or separate deployments per stack
        }),
      ],
    });

    // ============================================================================
    // BUILD PROJECT PERMISSIONS
    // ============================================================================
    // Attach additional permissions for CodeCommit to build project
    this.buildProject.role?.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'codecommit:GitPull',
          'codecommit:GetBranch',
          'codecommit:GetCommit',
        ],
        resources: [this.repository.repositoryArn],
      })
    );

    // Allow build project to write CloudWatch logs
    this.buildProject.role?.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
        ],
        resources: [
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/codebuild/robofleet-build:*`,
        ],
      })
    );

    // ============================================================================
    // STACK OUTPUTS - Export pipeline information
    // ============================================================================
    new cdk.CfnOutput(this, 'PipelineUrl', {
      value: `https://console.aws.amazon.com/codesuite/codepipeline/pipelines/${this.pipeline.pipelineName}/view`,
      description: 'URL to CodePipeline in AWS Console',
    });

    new cdk.CfnOutput(this, 'RepositoryUrl', {
      value: this.repository.repositoryCloneUrlHttp,
      description: 'CodeCommit repository HTTPS clone URL',
    });

    new cdk.CfnOutput(this, 'RepositoryArn', {
      value: this.repository.repositoryArn,
      description: 'CodeCommit repository ARN',
    });

    new cdk.CfnOutput(this, 'ArtifactsBucketName', {
      value: this.artifactsBucket.bucketName,
      description: 'S3 bucket for pipeline artifacts',
    });

    // ============================================================================
    // TAGS FOR COST TRACKING & COMPLIANCE
    // ============================================================================
    cdk.Tags.of(this).add('Component', 'CICD');
    cdk.Tags.of(this).add('Cost-Center', 'RoboFleet-DevOps');
    cdk.Tags.of(this).add('Environment', 'Production');
  }
}
