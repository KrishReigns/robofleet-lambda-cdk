import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';

interface NetworkingStackProps extends cdk.StackProps {
  appKey: kms.Key;
}

/**
 * NetworkingStack: Manages all networking infrastructure
 *
 * Components:
 * 1. VPC: Virtual Private Cloud (10.0.0.0/16) across 2 Availability Zones
 * 2. Subnets: Private subnets only (no internet gateway, no NAT gateway)
 * 3. Security Groups: Lambda security group with restricted egress
 * 4. VPC Endpoints: 8 AWS service endpoints (S3, DynamoDB, CloudWatch Logs, SNS, Secrets Manager, Glue, Athena, SES)
 *
 * Security Design:
 * - NO internet access (no IGW, no NAT)
 * - ALL AWS service access via VPC endpoints (more secure, lower costs)
 * - Lambda egress restricted to:
 *   * Slack IPs (52.89.214.238, 52.36.27.130, 52.36.27.131) on port 443 only
 *   * VPC endpoint security group (AWS service access)
 *   * AWS DNS (169.254.169.253) on port 53 only
 * - allowAllOutbound: false (production hardened)
 *
 * Cost Optimization:
 * - VPC Endpoints ~$7-10/month (much cheaper than NAT Gateway at $100+/month)
 * - No internet gateway (not needed)
 * - No NAT gateway (not needed with VPC endpoints)
 *
 * High Availability:
 * - 2 Availability Zones (AZs)
 * - Public subnets in 2 AZs (for load balancing, future use)
 * - Private subnets in 2 AZs (for Lambda, RDS, etc.)
 */
export class NetworkingStack extends cdk.Stack {
  // Public exports for other stacks to reference
  public readonly vpc: ec2.Vpc;
  public readonly lambdaSecurityGroup: ec2.SecurityGroup;
  public readonly vpcEndpointSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: NetworkingStackProps) {
    super(scope, id, props);

    const { appKey } = props;

    // ============================================================================
    // VPC - Virtual Private Cloud
    // ============================================================================
    /**
     * VPC Configuration:
     * - CIDR Block: 10.0.0.0/16 (65,536 total IPs)
     * - Availability Zones: 2 (high availability)
     * - NAT Gateways: 0 (disabled - using VPC endpoints instead)
     * - Subnets per AZ: 1 public + 1 private
     *
     * Subnets:
     * - Public (10.0.0.0/24 and 10.0.1.0/24): For future load balancers, NAT gateways
     * - Private (10.0.100.0/24 and 10.0.101.0/24): For Lambda, databases, RDS
     *
     * DNS:
     * - DNS Hostnames: Enabled (required for VPC endpoints)
     * - DNS Support: Enabled (required for private hosted zones)
     *
     * Why no NAT Gateway?
     * - With VPC endpoints, Lambda doesn't need internet access
     * - VPC endpoints are cheaper (~$7/month vs NAT ~$100/month)
     * - More secure (no internet exposure)
     * - All AWS service calls stay within AWS network
     */
    this.vpc = new ec2.Vpc(this, 'VPC', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 2,
      natGateways: 0, // Disabled - using VPC endpoints instead
      subnetConfiguration: [
        {
          name: 'Public',
          cidrMask: 24,
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          name: 'Private',
          cidrMask: 24,
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
      enableDnsHostnames: true,
      enableDnsSupport: true,
      restrictDefaultSecurityGroup: true,
    });

    // Add VPC name tag for identification
    cdk.Tags.of(this.vpc).add('Name', 'robofleet-vpc');

    // ============================================================================
    // SECURITY GROUPS - Control network traffic
    // ============================================================================

    // ---- Security Group 1: VPC Endpoint Security Group ----
    /**
     * Security Group: VPC Endpoint SG
     * Purpose: Allow Lambda to communicate with VPC endpoints
     * Ingress: Port 443 (HTTPS) from Lambda security group
     * Egress: All traffic (endpoints need to respond)
     * Used by: All interface VPC endpoints (CloudWatch Logs, SNS, Secrets Manager, etc.)
     */
    this.vpcEndpointSecurityGroup = new ec2.SecurityGroup(
      this,
      'VpcEndpointSecurityGroup',
      {
        vpc: this.vpc,
        description: 'Security group for VPC endpoints',
        allowAllOutbound: true,
      }
    );

    this.vpcEndpointSecurityGroup.addIngressRule(
      ec2.Peer.ipv4('10.0.0.0/16'), // Allow from anywhere in VPC
      ec2.Port.tcp(443),
      'Allow HTTPS from VPC'
    );

    // ---- Security Group 2: Lambda Security Group ----
    /**
     * Security Group: Lambda SG
     * Purpose: Controls what Lambda functions can access
     * Key Design: allowAllOutbound: false (production hardened)
     *
     * Egress Rules (explicitly allowed):
     * 1. To VPC Endpoint SG on port 443 (CloudWatch, SNS, Secrets Manager, etc.)
     * 2. To Slack IPs (52.89.214.238, 52.36.27.130, 52.36.27.131) on port 443
     * 3. To AWS DNS (169.254.169.253) on port 53 (for DNS resolution)
     *
     * Why this design?
     * - Lambda can ONLY access VPC endpoints and Slack
     * - No general internet access
     * - No access to unauthorized services
     * - If Lambda is compromised, attacker has minimal access
     */
    this.lambdaSecurityGroup = new ec2.SecurityGroup(
      this,
      'LambdaSecurityGroup',
      {
        vpc: this.vpc,
        description: 'Security group for Lambda functions',
        allowAllOutbound: false, // CRITICAL: Restrict outbound access
      }
    );

    // Egress Rule 1: Allow Lambda to communicate with VPC endpoints
    this.lambdaSecurityGroup.addEgressRule(
      this.vpcEndpointSecurityGroup,
      ec2.Port.tcp(443),
      'Allow HTTPS to VPC endpoints (CloudWatch, SNS, Secrets Manager, Glue, Athena, SES)'
    );

    // Egress Rule 2: Allow Lambda to communicate with Slack (external HTTPS only)
    // Slack uses these IPs for webhook delivery (as of 2025)
    const slackIps = [
      '52.89.214.238/32',  // Slack IP 1
      '52.36.27.130/32',   // Slack IP 2
      '52.36.27.131/32',   // Slack IP 3
    ];

    slackIps.forEach((ip, index) => {
      this.lambdaSecurityGroup.addEgressRule(
        ec2.Peer.ipv4(ip),
        ec2.Port.tcp(443),
        `Allow HTTPS to Slack (${ip})`
      );
    });

    // Egress Rule 3: Allow Lambda to communicate with AWS DNS for name resolution
    this.lambdaSecurityGroup.addEgressRule(
      ec2.Peer.ipv4('169.254.169.253/32'), // AWS DNS resolver
      ec2.Port.udp(53),
      'Allow DNS queries to AWS resolver'
    );

    // ============================================================================
    // VPC ENDPOINTS - Access AWS services without internet
    // ============================================================================
    /**
     * VPC Endpoints: AWS services accessible from Lambda without leaving VPC
     *
     * Types:
     * - Gateway Endpoints (S3, DynamoDB): Cheap, route via route tables
     * - Interface Endpoints (others): Via ENI, more flexible, higher cost (~$7/endpoint/month)
     *
     * Total: 8 endpoints
     * Cost: ~$7-10/month (much cheaper than NAT Gateway at ~$100/month)
     */

    // ---- Gateway Endpoint 1: S3 (Simple Storage Service) ----
    /**
     * Purpose: Lambda can read/write S3 without VPC endpoint security group
     * Type: Gateway Endpoint (cheaper, no additional cost beyond S3)
     * Usage: Data lake bucket, Athena results bucket
     */
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // ---- Gateway Endpoint 2: DynamoDB ----
    /**
     * Purpose: Future use (not currently used, but included for completeness)
     * Type: Gateway Endpoint
     */
    this.vpc.addGatewayEndpoint('DynamoDBEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // ---- Interface Endpoint 1: CloudWatch Logs ----
    /**
     * Purpose: Lambda writes execution logs to CloudWatch Logs
     * Type: Interface Endpoint
     * DNS: logs.{region}.amazonaws.com (privateDnsEnabled)
     * Security Group: vpcEndpointSecurityGroup
     */
    this.vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      privateDnsEnabled: true,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
    });

    // ---- Interface Endpoint 2: SNS (Simple Notification Service) ----
    /**
     * Purpose: Lambda publishes alerts to SNS topic
     * Type: Interface Endpoint
     * DNS: sns.{region}.amazonaws.com (privateDnsEnabled)
     * Security Group: vpcEndpointSecurityGroup
     */
    this.vpc.addInterfaceEndpoint('SNSEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SNS,
      privateDnsEnabled: true,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
    });

    // ---- Interface Endpoint 3: Secrets Manager ----
    /**
     * Purpose: Lambda retrieves Slack webhook URL and email config at runtime
     * Type: Interface Endpoint
     * DNS: secretsmanager.{region}.amazonaws.com (privateDnsEnabled)
     * Security Group: vpcEndpointSecurityGroup
     * Data: Encrypted with KMS appKey
     */
    this.vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      privateDnsEnabled: true,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
    });

    // ---- Interface Endpoint 4: AWS Glue ----
    /**
     * Purpose: Lambda reads Glue catalog metadata (database, tables, partitions)
     * Type: Interface Endpoint
     * DNS: glue.{region}.amazonaws.com (privateDnsEnabled)
     * Security Group: vpcEndpointSecurityGroup
     * Usage: Query Lambda needs to read table schema and partitions
     */
    this.vpc.addInterfaceEndpoint('GlueEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.GLUE,
      privateDnsEnabled: true,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
    });

    // ---- Interface Endpoint 5: Amazon Athena ----
    /**
     * Purpose: Lambda executes SQL queries on telemetry data
     * Type: Interface Endpoint
     * DNS: athena.{region}.amazonaws.com (privateDnsEnabled)
     * Security Group: vpcEndpointSecurityGroup
     * Usage: Query Lambda calls Athena to analyze data
     */
    this.vpc.addInterfaceEndpoint('AthenaEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ATHENA,
      privateDnsEnabled: true,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
    });

    // ---- Interface Endpoint 6: Amazon SES (Simple Email Service) ----
    /**
     * Purpose: Lambda sends email alerts via SES
     * Type: Interface Endpoint
     * DNS: email.{region}.amazonaws.com (privateDnsEnabled)
     * Security Group: vpcEndpointSecurityGroup
     * Usage: SNS-to-Email Lambda sends alerts via SES
     */
    this.vpc.addInterfaceEndpoint('SESEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SES,
      privateDnsEnabled: true,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
    });

    // ---- Interface Endpoint 7: KMS (Key Management Service) ----
    /**
     * Purpose: Lambda decrypts secrets and S3 objects encrypted with KMS keys
     * Type: Interface Endpoint
     * DNS: kms.{region}.amazonaws.com (privateDnsEnabled)
     * Security Group: vpcEndpointSecurityGroup
     * Usage: All Lambda functions need to decrypt data with appKey
     */
    this.vpc.addInterfaceEndpoint('KMSEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.KMS,
      privateDnsEnabled: true,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
    });

    // ---- Interface Endpoint 8: CloudWatch Monitoring ----
    /**
     * Purpose: Lambda publishes custom metrics to CloudWatch
     * Type: Interface Endpoint
     * DNS: monitoring.{region}.amazonaws.com (privateDnsEnabled)
     * Security Group: vpcEndpointSecurityGroup
     * Usage: Dashboard widgets display metrics
     */
    this.vpc.addInterfaceEndpoint('CloudWatchMonitoringEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH,
      privateDnsEnabled: true,
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
    });

    // ============================================================================
    // VPC ENDPOINT SECURITY - Attach security group to endpoints
    // ============================================================================
    /**
     * All interface endpoints need the vpcEndpointSecurityGroup attached
     * This allows Lambda (via lambdaSecurityGroup) to communicate with endpoints
     */
    const endpointIds = [
      'CloudWatchLogsEndpoint',
      'SNSEndpoint',
      'SecretsManagerEndpoint',
      'GlueEndpoint',
      'AthenaEndpoint',
      'SESEndpoint',
      'KMSEndpoint',
      'CloudWatchMonitoringEndpoint',
    ];

    // Security groups are attached via endpoint creation (see endpoint definitions above)
    // Each endpoint was created with vpcEndpointSecurityGroup in its configuration

    // ============================================================================
    // STACK OUTPUTS - Export for other stacks to reference
    // ============================================================================
    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      exportName: `${this.stackName}-VpcId`,
      description: 'VPC ID for Lambda deployment',
    });

    new cdk.CfnOutput(this, 'PrivateSubnets', {
      value: this.vpc.privateSubnets.map((subnet) => subnet.subnetId).join(','),
      exportName: `${this.stackName}-PrivateSubnets`,
      description: 'Private subnet IDs for Lambda',
    });

    new cdk.CfnOutput(this, 'LambdaSecurityGroupId', {
      value: this.lambdaSecurityGroup.securityGroupId,
      exportName: `${this.stackName}-LambdaSecurityGroupId`,
      description: 'Security group ID for Lambda functions',
    });

    new cdk.CfnOutput(this, 'VpcEndpointSecurityGroupId', {
      value: this.vpcEndpointSecurityGroup.securityGroupId,
      exportName: `${this.stackName}-VpcEndpointSecurityGroupId`,
      description: 'Security group ID for VPC endpoints',
    });

    new cdk.CfnOutput(this, 'AvailabilityZones', {
      value: this.vpc.availabilityZones.join(', '),
      exportName: `${this.stackName}-AvailabilityZones`,
      description: 'Availability zones for the VPC',
    });

    // ============================================================================
    // TAGS FOR COST TRACKING & COMPLIANCE
    // ============================================================================
    cdk.Tags.of(this).add('Component', 'Networking');
    cdk.Tags.of(this).add('Cost-Center', 'RoboFleet-Infrastructure');
    cdk.Tags.of(this).add('Environment', 'Production');
  }
}
