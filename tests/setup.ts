/**
 * Jest Setup File
 * Runs before all tests
 */

// Mock AWS SDK clients globally
jest.mock('@aws-sdk/client-s3');
jest.mock('@aws-sdk/client-athena');
jest.mock('@aws-sdk/client-secrets-manager');
jest.mock('@aws-sdk/client-ses');
jest.mock('@aws-sdk/client-glue');

// Set test environment variables
process.env.AWS_REGION = 'us-east-1';
process.env.DATA_LAKE_BUCKET = 'robofleet-data-lake-test';
process.env.ATHENA_RESULTS_BUCKET = 'robofleet-athena-results-test';
process.env.GLUE_DATABASE = 'robofleet_db_test';

// Suppress console output during tests (optional)
// global.console.log = jest.fn();
// global.console.error = jest.fn();
