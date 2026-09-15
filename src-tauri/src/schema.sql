-- The index: one row per session, what each session used and when, and what
-- makes rescanning incremental.
--
-- No transcript text is stored. Bodies stay in the agents' own files and are
-- read when a conversation is opened, which is why this database stays small
-- and can be rebuilt from those files at any time.

CREATE TABLE sessions (
    id           TEXT PRIMARY KEY,
    agent        TEXT    NOT NULL,
    native_id    TEXT    NOT NULL,
    title        TEXT,
    cwd          TEXT,
    branch       TEXT,
    started_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    spawned      INTEGER NOT NULL DEFAULT 0,
    role         TEXT,
    -- The model shares as JSON, and the totals below, are sums of the session's
    -- usage, kept on the row so a list row needs no join.
    models       TEXT    NOT NULL DEFAULT '[]',
    input        INTEGER NOT NULL DEFAULT 0,
    output       INTEGER NOT NULL DEFAULT 0,
    cache_read   INTEGER NOT NULL DEFAULT 0,
    cache_write  INTEGER NOT NULL DEFAULT 0,
    reasoning    INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    -- Null means none of the session's usage is priced, which is not zero.
    cost_usd     REAL,
    -- Null until the conversation has been read in full.
    messages     INTEGER,
    tools        INTEGER,
    -- The latest file the session was read from.
    path         TEXT    NOT NULL,
    present      INTEGER NOT NULL DEFAULT 1
);

-- Every ordering the list offers reaches one of these, so sorting never scans
-- the table. The filtered indexes match the default view, which hides runs an
-- agent spawned for itself.
CREATE INDEX sessions_updated ON sessions (updated_at DESC);
CREATE INDEX sessions_started ON sessions (started_at DESC);
CREATE INDEX sessions_tokens  ON sessions (total_tokens DESC);
CREATE INDEX sessions_cost    ON sessions (cost_usd DESC);
CREATE INDEX sessions_title   ON sessions (title);
CREATE INDEX sessions_agent   ON sessions (agent, updated_at DESC);
CREATE INDEX sessions_path    ON sessions (path);
CREATE INDEX sessions_own     ON sessions (updated_at DESC) WHERE spawned = 0;

-- What each session used, by quarter hour, provider and model, so a period or
-- a day counts only the usage inside it. Each file a session spans keeps its
-- own rows under the file's name: a thread continued in a new file adds to
-- them, and a file moved to an archive replaces its own. Agent is repeated so
-- totals by agent need no join.
CREATE TABLE usage (
    session_id  TEXT    NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    source      TEXT    NOT NULL,
    at          INTEGER NOT NULL,
    -- Who served it, as the agent names them, such as `anthropic`; empty when
    -- the agent recorded none.
    provider    TEXT    NOT NULL,
    -- The model's name: the id the agent recorded, less any path in front of
    -- it, such as OpenRouter's `google/`. Empty when the agent recorded no
    -- model.
    model       TEXT    NOT NULL,
    agent       TEXT    NOT NULL,
    input       INTEGER NOT NULL,
    output      INTEGER NOT NULL,
    cache_read  INTEGER NOT NULL,
    cache_write INTEGER NOT NULL,
    reasoning   INTEGER NOT NULL,
    total       INTEGER NOT NULL,
    cost_usd    REAL,
    PRIMARY KEY (session_id, source, at, provider, model)
);

CREATE INDEX usage_at ON usage (at);

-- What each source file looked like when it was last read. A file whose
-- modification time and size both match is skipped entirely.
CREATE TABLE files (
    path   TEXT PRIMARY KEY,
    mtime  INTEGER NOT NULL,
    size   INTEGER NOT NULL
);

-- The last limits read for each subscription account, as JSON, so they show at
-- once on launch. Rows are replaced a subscription at a time.
CREATE TABLE accounts (
    id       TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    account  TEXT NOT NULL
);

CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
