-- v1.0: the permission to download all of the business's data (FR-AUD-03). The Owner holds every permission already; it can be given to others on the Roles screen.
INSERT INTO permissions (key, description) VALUES
  ('data.export', 'Download all of the business''s data as a file (Owner)')
ON CONFLICT (key) DO NOTHING;
