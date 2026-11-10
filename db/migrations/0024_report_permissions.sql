-- v0.7 slice 2: who may see profit and the tax summary in the report catalogue (FR-RPT-04, FR-TAX-05).
--
-- reports.profit.view: any report that shows costs or profit, and the cost and profit columns inside other reports. Without it a person
-- sees sales only. reports.tax.view: the sales tax summary (output and input tax by rate). Owner and Manager hold both.

INSERT INTO permissions (key, description) VALUES
  ('reports.profit.view', 'See profit, cost of goods and stock value in reports and exports'),
  ('reports.tax.view', 'See the sales tax summary (output and input tax by rate)')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, k.key FROM roles r
CROSS JOIN (VALUES ('reports.profit.view'), ('reports.tax.view')) AS k(key)
WHERE r.is_system AND r.name IN ('Owner', 'Manager')
ON CONFLICT DO NOTHING;
