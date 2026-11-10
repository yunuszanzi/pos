-- v0.6 slice 7: share a document by link (FR-PRT-07; acceptance "a quote shared by a WhatsApp link opens on a phone"). API-only like the rest.
--
-- A share is an unguessable token that lets anyone holding the link READ one document, with no sign-in: a customer opens the quotation
-- or invoice on their phone. The token is 256 random bits, so it cannot be guessed; it expires (30 days by default) and can be revoked.
-- It shows the document as it was printed (prices, tax, terms), never costs. Opening it is counted.

CREATE TABLE document_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  doc_type text NOT NULL CHECK (doc_type IN ('quotation', 'sales_order', 'invoice', 'delivery_challan')),
  doc_id uuid NOT NULL,
  token text NOT NULL UNIQUE CHECK (length(token) >= 40),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  view_count integer NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  last_viewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE INDEX document_shares_doc_idx ON document_shares (business_id, doc_type, doc_id);

ALTER TABLE document_shares ENABLE ROW LEVEL SECURITY;
