/** 첫 저장 단계: 프로젝트·작업·큐·operation·이벤트만. 다른 도메인 표는 후속 마이그레이션이다. */
export const initialSchema = `
CREATE TABLE schema_migrations (
  id INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
);
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL,
  repo_key TEXT NOT NULL UNIQUE, default_branch TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0), created_at TEXT NOT NULL
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  original_prompt TEXT NOT NULL, phase TEXT NOT NULL CHECK (phase IN ('discussion','provisioning','execution','review','archived')),
  run_state TEXT NOT NULL CHECK (run_state IN ('idle','running','waiting_input','reconnecting','stopping','paused','failed')),
  integration_state TEXT NOT NULL DEFAULT 'none' CHECK (integration_state IN ('none','awaiting_approval','queued','preparing','conflicted','merging','merged','pushing','pr_pending','done','failed','unknown')),
  disposition TEXT NOT NULL DEFAULT 'active' CHECK (disposition IN ('active','completed','cancelled')),
  queue_mode TEXT NOT NULL DEFAULT 'enabled' CHECK (queue_mode IN ('enabled','paused')),
  worktree_path TEXT, revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK (phase <> 'discussion' OR worktree_path IS NULL),
  CHECK (phase <> 'execution' OR worktree_path IS NOT NULL),
  CHECK (disposition <> 'cancelled' OR run_state <> 'running')
);
CREATE INDEX tasks_project_created ON tasks(project_id, created_at);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','assistant','tool','system')),
  content TEXT NOT NULL, attachment_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(attachment_ids_json)),
  delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('immediate','queued','discussion')),
  queue_state TEXT NOT NULL CHECK (queue_state IN ('none','queued','dispatching','accepted','finished','failed','unknown','deleted')),
  queue_position INTEGER CHECK (queue_position IS NULL OR queue_position >= 0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK (delivery_mode = 'queued' OR queue_position IS NULL)
);
CREATE UNIQUE INDEX messages_queue_position ON messages(task_id, queue_position) WHERE queue_position IS NOT NULL;
CREATE TABLE operations (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, scope_key TEXT NOT NULL,
  method TEXT NOT NULL, payload_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('accepted','running','succeeded','failed','unknown')),
  result_json TEXT, error_json TEXT, created_at TEXT NOT NULL
);
CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL, payload_json TEXT NOT NULL CHECK (json_valid(payload_json)), created_at TEXT NOT NULL
);
`;

export const viewSchema = `
CREATE TABLE drafts (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK (scope IN ('project','task')),
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
  text TEXT NOT NULL, attachment_ids_json TEXT NOT NULL CHECK (json_valid(attachment_ids_json)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  CHECK ((scope='project' AND project_id IS NOT NULL AND task_id IS NULL) OR
         (scope='task' AND task_id IS NOT NULL AND project_id IS NULL))
);
CREATE UNIQUE INDEX drafts_project ON drafts(project_id) WHERE scope='project';
CREATE UNIQUE INDEX drafts_task ON drafts(task_id) WHERE scope='task';
CREATE TABLE view_states (
  id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
  layout_json TEXT NOT NULL CHECK (json_valid(layout_json)),
  tabs_json TEXT NOT NULL CHECK (json_valid(tabs_json)),
  cursors_json TEXT NOT NULL CHECK (json_valid(cursors_json)),
  scroll_json TEXT NOT NULL CHECK (json_valid(scroll_json)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0), updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX view_task ON view_states(task_id) WHERE task_id IS NOT NULL;
`;

export const runtimeSchema = `
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('file','folder','image','code-selection')),
  relative_path TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX attachments_task ON attachments(task_id, created_at);

CREATE TABLE settings_snapshots (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('project','task')),
  owner_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  settings_json TEXT NOT NULL CHECK (json_valid(settings_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scope, owner_id)
);

CREATE TABLE input_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('pending','answered','expired','cancelled')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT
);
CREATE INDEX input_requests_task_status ON input_requests(task_id, status);

CREATE TABLE integration_journals (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE RESTRICT,
  repo_key TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  expected_head TEXT,
  state TEXT NOT NULL CHECK (state IN ('awaiting_approval','queued','preparing','conflicted','merging','merged','pushing','pr_pending','done','failed','unknown')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  updated_at TEXT NOT NULL
);

CREATE TABLE process_records (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  role TEXT NOT NULL,
  pid INTEGER NOT NULL CHECK (pid > 0),
  start_token TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running','exited','unknown')),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  updated_at TEXT NOT NULL
);
CREATE INDEX process_records_task_state ON process_records(task_id, state);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL,
  location TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX artifacts_task ON artifacts(task_id, created_at);
`;
