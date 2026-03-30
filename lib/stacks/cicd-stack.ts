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
 * 1. Source  — Poll CodeCommit main branch
 * 2. Build   — Compile TypeScript, run tests, cdk synth
 * 3. Deploy  — Manual approval → cdk deploy --all (all 5 stacks)
 */
export class CICDStack extends cdk.Stack {
  public readonly pipeline: codepipeline.Pipeline;
  public readonly buildProject: codebuild.PipelineProject;
  public readonly deployProject: codebuild.PipelineProject;
  public readonly repository: codecommit.Repository;
  public readonly artifactsBucket: s3.IBucket;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ============================================================================
    // S3 ARTIFACTS BUCKET
    // ============================================================================
    this.artifactsBucket = s3.Bucket.fromBucketName(
      this,
      'ArtifactsBucket',
      `robofleet-cicd-artifacts-${cdk.Stack.of(this).account}`
    );

    // ============================================================================
    // CODECOMMIT REPOSITORY
    // ============================================================================
    this.repository = new codecommit.Repository(this, 'Repository', {
      repositoryName: 'robofleet-lambda',
      description: 'Robofleet Lambda CDK infrastructure and application code',
    });

    // ============================================================================
    // CODEBUILD — Build project (compile + test + synth)
    // ============================================================================
    this.buildProject = new codebuild.PipelineProject(this, 'BuildProject', {
      projectName: 'robofleet-build',
      description: 'Compile, test and synthesize robofleet CDK stacks',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: false,
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

    this.artifactsBucket.grantReadWrite(this.buildProject);

    // ============================================================================
    // CODEBUILD — Deploy project (cdk deploy --all)
    // ============================================================================
    this.deployProject = new codebuild.PipelineProject(this, 'DeployProject', {
      projectName: 'robofleet-deploy',
      description: 'Deploy all robofleet CDK stacks via cdk deploy --all',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: false,
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo "Installing dependencies..."',
              'npm ci --include=dev',
            ],
          },
          build: {
            commands: [
              'echo "Deploying robofleet CDK stacks..."',
              `./node_modules/.bin/cdk deploy RobofleetSecurityStack RobofleetStorageStack RobofleetComputeStack RobofleetCICDStack --require-approval never --region ${cdk.Stack.of(this).region}`,
              'echo "All stacks deployed successfully"',
            ],
          },
        },
      }),
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
          logGroup: new cdk.aws_logs.LogGroup(this, 'DeployLogs', {
            logGroupName: '/aws/codebuild/robofleet-deploy',
            retention: cdk.aws_logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          }),
        },
      },
    });

    this.artifactsBucket.grantReadWrite(this.deployProject);

    // Grant deploy project AdministratorAccess to deploy all CDK stacks
    this.deployProject.role?.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')
    );

    // ============================================================================
    // CODEPIPELINE
    // ============================================================================
    this.pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: 'robofleet-pipeline',
      artifactBucket: this.artifactsBucket,
      restartExecutionOnUpdate: true,
    });

    // ---- Stage 1: Source ----
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
    const buildOutput = new codepipeline.Artifact('robofleet-build-artifact');

    this.pipeline.addStage({
      stageName: 'Build',
      actions: [
        new codepipelineActions.CodeBuildAction({
          actionName: 'Build',
          project: this.buildProject,
          input: sourceOutput,
          outputs: [buildOutput],
        }),
      ],
    });

    // ---- Stage 3: Approve ----
    this.pipeline.addStage({
      stageName: 'Approve',
      actions: [
        new codepipelineActions.ManualApprovalAction({
          actionName: 'ApproveDeployment',
          additionalInformation: 'Review build output and approve deployment of all 5 CDK stacks',
        }),
      ],
    });

    // ---- Stage 4: Deploy ----
    this.pipeline.addStage({
      stageName: 'Deploy',
      actions: [
        new codepipelineActions.CodeBuildAction({
          actionName: 'CDKDeployAll',
          project: this.deployProject,
          input: buildOutput,
        }),
      ],
    });

    // ============================================================================
    // BUILD PROJECT PERMISSIONS
    // ============================================================================
    this.buildProject.role?.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['codecommit:GitPull', 'codecommit:GetBranch', 'codecommit:GetCommit'],
        resources: [this.repository.repositoryArn],
      })
    );

    this.buildProject.role?.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/codebuild/robofleet-build:*`],
      })
    );

    // ============================================================================
    // STACK OUTPUTS
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

    cdk.Tags.of(this).add('Component', 'CICD');
    cdk.Tags.of(this).add('Cost-Center', 'RoboFleet-DevOps');
    cdk.Tags.of(this).add('Environment', 'Production');
  }
}
