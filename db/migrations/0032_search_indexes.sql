-- v1.0 performance (NFR-PRF-01): searching a catalogue of 20,000 SKUs by part of a name, SKU or barcode.
--
-- The product search matches text anywhere inside (ILIKE '%part%'), which an ordinary index cannot help with, so every search read the
-- whole product, variant and unit tables (about 190 ms at 20,000 SKUs). Trigram indexes make the same query read only the rows that match.

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX products_name_trgm_idx ON products USING gin (name extensions.gin_trgm_ops);
CREATE INDEX product_variants_sku_trgm_idx ON product_variants USING gin (sku extensions.gin_trgm_ops);
CREATE INDEX product_units_barcode_trgm_idx ON product_units USING gin (barcode extensions.gin_trgm_ops) WHERE barcode IS NOT NULL;
