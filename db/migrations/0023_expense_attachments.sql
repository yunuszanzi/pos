-- v0.7 slice 1b: a photo or PDF of the bill on an expense (FR-CSH-05). The file lives in a PRIVATE storage bucket; nobody reads it
-- directly. The API checks who may see the expense and hands out a signed link that works for a few minutes. Images and PDFs only, 5 MB.

DO $$
BEGIN
  -- A database without the storage service (a bare test database) simply has no bucket; uploads then fail with a clear message.
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('expense-attachments', 'expense-attachments', false, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
    ON CONFLICT (id) DO NOTHING;
  END IF;
END
$$;
