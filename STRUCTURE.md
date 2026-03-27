# Robofleet Lambda CDK - Project Structure

## Directory Organization

```
robofleet-lambda-cdk/
├── bin/
│   └── app.ts                          # CDK app entry point
│
├── lib/stacks/
│   ├── cicd-stack.ts                   # CI/CD Pipeline (CodeCommit, CodeBuild, CodePipeline)
│   ├── compute-stack.ts                # Lambda Functions, SNS Topics, CloudWatch
│   ├── networking-stack.ts             # VPC, Security Groups, VPC Endpoints
│   ├── security-stack.ts               # IAM Roles, KMS Keys, Secrets Manager
│   └── storage-stack.ts                # S3 Buckets, Glue Catalog, Athena
│
├── src/functions/
│   ├── ingest/
│   │   └── index.ts                    # Device telemetry ingestion handler
│   ├── query/
│   │   └── index.ts                    # Athena SQL query execution handler
│   ├── processing/
│   │   └── index.ts                    # Telemetry aggregation & optimization handler
│   ├── sns-to-email/
│   │   └── index.ts                    # CloudWatch alarms → SES email handler
│   └── sns-to-slack/
│       └── index.ts                    # CloudWatch alarms → Slack handler
│
├── tests/
│   ├── setup.ts                        # Jest setup with AWS SDK mocks
│   └── unit/
│       └── ingest.test.ts              # Unit tests for ingest handler
│
├── .github/workflows/                  # GitHub Actions workflows (future)
│
├── buildspec.yml                       # CodeBuild configuration
├── cdk.json                            # CDK configuration
├── cdk.context.json                    # CDK context values
├── jest.config.js                      # Jest test configuration
├── package.json                        # Node.js dependencies
├── tsconfig.json                       # TypeScript configuration
├── .gitignore                          # Git ignore patterns
├── .npmignore                          # NPM ignore patterns
├── README.md                           # Project documentation
└── DEPLOYMENT_GUIDE.md                 # Deployment instructions
```

## Key Improvements

1. **Lambda Functions Organized by Handler**
   - Each Lambda function now has its own directory
   - Cleaner imports and easier to scale as handlers grow
   - Entry point: `src/functions/{function-name}/index.ts`

2. **CDK Stacks Centralized**
   - All infrastructure code in `lib/stacks/`
   - Clear separation of concerns
   - Easy to reference and modify

3. **Tests Properly Grouped**
   - Unit tests in `tests/unit/` by function
   - Setup file for common mocks and configuration
   - Ready to scale with more test suites

4. **Configuration Files in Root**
   - `buildspec.yml` - CodeBuild expects this in root
   - `jest.config.js` - Jest looks for this in root
   - Standard Node.js convention

5. **Removed Clutter**
   - No empty directories
   - No scattered configuration files
   - No duplicate files or old test directories

## File Size Summary

- **Lambda Handlers**: ~220 lines of business logic
- **CDK Stacks**: ~1,500+ lines of infrastructure
- **Tests**: ~50 lines of test setup + sample tests
- **Configuration**: ~100 lines total

## Build & Deploy Commands

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run build

# Run tests
npm run test

# CDK commands
npm run cdk -- synth        # Generate CloudFormation
npm run cdk -- deploy       # Deploy stacks
npm run cdk -- destroy      # Tear down infrastructure
```
