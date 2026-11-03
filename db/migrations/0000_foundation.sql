CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name text NOT NULL,
  trade_name text NOT NULL,
  logo_url text,
  address text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  ntn text,
  strn text,
  province text NOT NULL DEFAULT '',
  receipt_footer text NOT NULL DEFAULT '',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  code text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, code),
  UNIQUE (id, business_id)
);

CREATE TABLE locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  name text NOT NULL,
  type text NOT NULL DEFAULT 'store' CHECK (type IN ('store', 'warehouse', 'damaged')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, business_id) REFERENCES branches(id, business_id) ON DELETE CASCADE,
  UNIQUE (id, business_id)
);

CREATE TABLE terminals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  name text NOT NULL,
  default_print_format text NOT NULL DEFAULT 'pos80' CHECK (default_print_format IN ('pos80', 'pos58', 'a4', 'a5')),
  fbr_pos_id text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, business_id) REFERENCES branches(id, business_id) ON DELETE CASCADE,
  UNIQUE (id, business_id)
);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name text NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, name),
  UNIQUE (id, business_id)
);

CREATE TABLE permissions (
  key text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE users (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  role_id uuid NOT NULL,
  email text NOT NULL,
  display_name text NOT NULL,
  pin_hash text,
  active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (role_id, business_id) REFERENCES roles(id, business_id),
  UNIQUE (business_id, email)
);

CREATE TABLE user_branches (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, branch_id)
);

CREATE TABLE auth_sessions (
  session_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_activity_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pin_attempts (
  rate_key text PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  window_started_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE document_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL,
  doc_type text NOT NULL,
  prefix text NOT NULL,
  next_number integer NOT NULL DEFAULT 1 CHECK (next_number > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, business_id) REFERENCES branches(id, business_id) ON DELETE CASCADE,
  UNIQUE (business_id, branch_id, doc_type)
);

CREATE TABLE business_settings (
  business_id uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  currency text NOT NULL DEFAULT 'PKR' CHECK (currency = 'PKR'),
  timezone text NOT NULL DEFAULT 'Asia/Karachi' CHECK (timezone = 'Asia/Karachi'),
  date_format text NOT NULL DEFAULT 'dd/MM/yyyy' CHECK (date_format IN ('dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd')),
  amount_rounding integer NOT NULL DEFAULT 2 CHECK (amount_rounding BETWEEN 0 AND 2),
  session_timeout_minutes integer NOT NULL DEFAULT 30 CHECK (session_timeout_minutes BETWEEN 5 AND 240),
  pos_session_timeout_hours integer NOT NULL DEFAULT 12 CHECK (pos_session_timeout_hours BETWEEN 1 AND 24),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  entity text NOT NULL,
  entity_id text NOT NULL,
  action text NOT NULL,
  before jsonb,
  after jsonb,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  terminal_id uuid REFERENCES terminals(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX branches_business_id_idx ON branches (business_id);
CREATE INDEX locations_business_branch_idx ON locations (business_id, branch_id);
CREATE INDEX terminals_business_branch_idx ON terminals (business_id, branch_id);
CREATE INDEX users_business_role_idx ON users (business_id, role_id);
CREATE INDEX audit_business_created_idx ON audit_log (business_id, created_at DESC);
CREATE INDEX audit_entity_idx ON audit_log (business_id, entity, entity_id);

CREATE FUNCTION deny_audit_log_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;

CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION deny_audit_log_mutation();

ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE terminals ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE pin_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY business_member_read ON businesses FOR SELECT TO authenticated
  USING (id IN (SELECT business_id FROM public.users WHERE id = auth.uid() AND active));
CREATE POLICY scoped_read_branches ON branches FOR SELECT TO authenticated
  USING (business_id IN (SELECT business_id FROM public.users WHERE id = auth.uid() AND active));
CREATE POLICY scoped_read_locations ON locations FOR SELECT TO authenticated
  USING (business_id IN (SELECT business_id FROM public.users WHERE id = auth.uid() AND active));
CREATE POLICY scoped_read_terminals ON terminals FOR SELECT TO authenticated
  USING (business_id IN (SELECT business_id FROM public.users WHERE id = auth.uid() AND active));
CREATE POLICY scoped_read_roles ON roles FOR SELECT TO authenticated
  USING (business_id IN (SELECT business_id FROM public.users WHERE id = auth.uid() AND active));
CREATE POLICY authenticated_read_permissions ON permissions FOR SELECT TO authenticated USING (true);
CREATE POLICY scoped_read_role_permissions ON role_permissions FOR SELECT TO authenticated
  USING (role_id IN (SELECT id FROM public.roles WHERE business_id IN
    (SELECT business_id FROM public.users WHERE id = auth.uid() AND active)));
CREATE POLICY self_read_user_profile ON users FOR SELECT TO authenticated
  USING (id = auth.uid() AND active);
CREATE POLICY self_read_user_branches ON user_branches FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY self_read_auth_sessions ON auth_sessions FOR SELECT TO authenticated
  USING (user_id = auth.uid());
CREATE POLICY scoped_read_document_series ON document_series FOR SELECT TO authenticated
  USING (business_id IN (SELECT business_id FROM public.users WHERE id = auth.uid() AND active));
CREATE POLICY business_member_read_settings ON business_settings FOR SELECT TO authenticated
  USING (business_id IN (SELECT business_id FROM public.users WHERE id = auth.uid() AND active));
CREATE POLICY scoped_read_audit ON audit_log FOR SELECT TO authenticated
  USING (business_id IN (SELECT business_id FROM public.users WHERE id = auth.uid() AND active));

INSERT INTO permissions (key, description) VALUES
  ('*', 'All current and future permissions'),
  ('business.view', 'View business profile'),
  ('business.update', 'Update business profile'),
  ('branches.view', 'View branches'),
  ('branches.manage', 'Create, update and deactivate branches'),
  ('locations.view', 'View stock locations'),
  ('locations.manage', 'Create, update and deactivate locations'),
  ('terminals.view', 'View terminals'),
  ('terminals.manage', 'Create, update and deactivate terminals'),
  ('document_series.view', 'View document numbering series'),
  ('document_series.manage', 'Manage document numbering series'),
  ('users.view', 'View users'),
  ('users.manage', 'Invite, update and deactivate users'),
  ('roles.view', 'View roles and permission assignments'),
  ('roles.manage', 'Manage roles and permission assignments'),
  ('settings.view', 'View business settings'),
  ('settings.manage', 'Update business settings'),
  ('audit.view', 'View audit history'),
  ('auth.pin_switch', 'Switch the active terminal user with a PIN'),
  ('auth.manager_override', 'Approve a manager-PIN override')
ON CONFLICT (key) DO NOTHING;
