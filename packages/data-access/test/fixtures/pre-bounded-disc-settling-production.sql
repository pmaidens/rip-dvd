INSERT INTO optical_drives (
  id, device_path, is_enabled, is_present, last_seen_at, created_at, updated_at
) VALUES
  ('fixture-running-drive', '/dev/fixture-running', 1, 1, 100, 100, 100),
  ('fixture-completed-drive', '/dev/fixture-completed', 1, 1, 100, 100, 200);

INSERT INTO detected_discs (
  id, optical_drive_id, disc_kind, fingerprint, status, detected_at,
  created_at, updated_at
) VALUES (
  'fixture-completed-disc', 'fixture-completed-drive', 'dvd',
  'fixture-completed-fingerprint', 'scanned', 100, 100, 200
);

INSERT INTO disc_inspections (
  id, optical_drive_id, detected_disc_id, media_generation, is_current,
  status, phase, attempt_count, consecutive_failure_count, volume_label,
  title_count, chapter_count, audio_stream_count, subtitle_stream_count,
  total_bytes, bytes_hashed, bytes_per_second, eta_seconds, retry_at,
  manual_retry_requested_at, reason_code, diagnostic, claim_token,
  claim_updated_at, phase_started_at, attempt_started_at, started_at,
  completed_at, created_at, updated_at
) VALUES
  (
    'fixture-running-inspection', 'fixture-running-drive', NULL,
    'fixture-running-generation', 1, 'running', 'reading_metadata', 2, 1,
    'FIXTURE_RUNNING', 3, 12, 2, 1, 4700000000, NULL, NULL, NULL, NULL,
    NULL, NULL, 'synthetic running inspection', 'fixture-claim', 190, 180,
    170, 100, NULL, 100, 200
  ),
  (
    'fixture-completed-inspection', 'fixture-completed-drive',
    'fixture-completed-disc', 'fixture-completed-generation', 1, 'completed',
    'confirming_media', 1, 0, 'FIXTURE_COMPLETED', 1, 4, 1, 0, 204800,
    204800, 2048, 0, NULL, NULL, NULL, NULL, NULL, NULL, 180, 100, 100,
    200, 100, 200
  );

INSERT INTO disc_inspection_attempts (
  id, disc_inspection_id, attempt_number, outcome, phase, reason_code,
  diagnostic, started_at, ended_at
) VALUES
  (
    'fixture-running-attempt-1', 'fixture-running-inspection', 1, 'failed',
    'reading_metadata', 'metadata_read_failed', 'synthetic retry evidence',
    100, 160
  ),
  (
    'fixture-completed-attempt-1', 'fixture-completed-inspection', 1,
    'completed', 'confirming_media', NULL, NULL, 100, 200
  );
