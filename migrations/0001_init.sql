CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  games INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Listing only. The Room Durable Object holds the real state and keeps this row current.
CREATE TABLE rooms (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  host_name TEXT NOT NULL,
  public INTEGER NOT NULL,
  status TEXT NOT NULL,          -- open | playing | empty
  players INTEGER NOT NULL,
  max_players INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX rooms_listing ON rooms(status, public, updated_at);
