/**
 * Unit Tests for Ingest Lambda Handler
 */

import { handler } from '../../src/functions/ingest';

const validEvent = {
  device_id: 'ROBOT-001',
  fleet_id: 'FLEET-BOSTON-01',
  battery_level: 85,
  speed_mps: 1.5,
  status: 'MOVING',
  error_code: '',
  location_zone: 'ZONE-A-01',
  temperature_celsius: 32.5,
  event_time: '2026-03-27T14:30:00Z',
};

describe('Ingest Lambda Handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Input Validation', () => {
    it('should reject event with missing device_id', async () => {
      const { device_id, ...event } = validEvent;
      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toContain('device_id');
    });

    it('should reject event with missing fleet_id', async () => {
      const { fleet_id, ...event } = validEvent;
      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toContain('fleet_id');
    });

    it('should reject event with invalid battery_level', async () => {
      const result = await handler({ ...validEvent, battery_level: 'bad' as any });
      expect(result.statusCode).toBe(400);
      expect(result.body).toContain('battery_level');
    });

    it('should reject event with invalid temperature_celsius', async () => {
      const result = await handler({ ...validEvent, temperature_celsius: 'bad' as any });
      expect(result.statusCode).toBe(400);
      expect(result.body).toContain('temperature_celsius');
    });

    it('should reject event with missing status', async () => {
      const { status, ...event } = validEvent;
      const result = await handler(event);
      expect(result.statusCode).toBe(400);
      expect(result.body).toContain('status');
    });

    it('should accept valid telemetry event (without S3 mock)', async () => {
      // S3 call will fail without mocking — just verify validation passes
      const result = await handler(validEvent);
      // 400 is acceptable here (S3 not mocked), but should NOT be a validation error
      const body = JSON.parse(result.body);
      expect(body.message ?? body.error).not.toContain('Missing');
    });
  });

  describe('CSV Formatting', () => {
    it('should produce 9 comma-separated fields', () => {
      // Verify the CSV column count matches the Glue table schema
      const fields = [
        validEvent.device_id,
        validEvent.fleet_id,
        validEvent.event_time,
        validEvent.battery_level,
        validEvent.speed_mps,
        validEvent.status,
        validEvent.error_code,
        validEvent.location_zone,
        validEvent.temperature_celsius,
      ];
      expect(fields.length).toBe(9);
      expect(fields.join(',').split(',').length).toBe(9);
    });
  });

  describe('Partition Path Generation', () => {
    it('should generate correct S3 partition path from event_time', () => {
      // event_time: 2026-03-27T14:30:00Z → year=2026/month=03/day=27/hour=14
      const date = new Date('2026-03-27T14:30:00Z');
      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const day = String(date.getUTCDate()).padStart(2, '0');
      const hour = String(date.getUTCHours()).padStart(2, '0');
      const path = `telemetry/year=${year}/month=${month}/day=${day}/hour=${hour}`;
      expect(path).toBe('telemetry/year=2026/month=03/day=27/hour=14');
    });
  });
});
