// Phase 10 — workspace resolution helpers.
//
// Every user owns exactly one personal workspace (user_id ↔ workspace_id is
// 1:1 in Phase 10). These helpers are the single source of truth for "which
// workspace is this user acting in" and "what role do they hold", so Phase 10.5
// (real multi-member teams + a session-based active workspace) becomes a
// localized change here rather than a codebase-wide refactor.

const { getDb } = require('../db');
const { TRIAL_DAYS } = require('../config');

// The workspace the user is currently acting in.
//   Phase 10:  always their owned personal workspace.
//   Phase 10.5: will consult session.activeWorkspaceId, falling back to this.
function getUserCurrentWorkspace(userId) {
  if (!userId) return null;
  return getDb().prepare(
    'SELECT * FROM workspaces WHERE owner_user_id = ? ORDER BY id ASC LIMIT 1'
  ).get(userId) || null;
}

function getWorkspaceById(workspaceId) {
  if (!workspaceId) return null;
  return getDb().prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) || null;
}

// 'owner' | 'admin' | 'member' | null.
//   Phase 10: 'owner' for the user's own workspace, null for any other.
function getUserRole(userId, workspaceId) {
  if (!userId || !workspaceId) return null;
  const row = getDb().prepare(
    'SELECT role FROM workspace_members WHERE user_id = ? AND workspace_id = ?'
  ).get(userId, workspaceId);
  return row ? row.role : null;
}

// Bootstrap a user's personal workspace + owner membership. Single source of
// truth used by BOTH the startup migration (existing users) and registration
// (new users), so a fresh signup is never left workspace-less.
//
// Idempotent: if the user already owns a personal workspace, returns its id
// without creating a duplicate. Atomic via SAVEPOINT, which nests safely whether
// or not the caller is already inside a transaction (the migration is; the
// registration route is not).
function createPersonalWorkspace(userId, name, email) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM workspaces WHERE owner_user_id = ? ORDER BY id ASC LIMIT 1').get(userId);
  if (existing) return existing.id;

  const base = (name && String(name).trim()) || String(email || '').split('@')[0] || 'My';
  const wsName = `${base}'s workspace`;

  return db.savepoint(() => {
    // Every new workspace starts a TRIAL_DAYS Pro trial (no card, no plan
    // choice). trial_ends_at is the only trigger: getWorkspaceTier treats an
    // unexpired trial as effective Pro, and expiry falls back to Free naturally.
    const r = db.prepare(
      "INSERT INTO workspaces (name, owner_user_id, subscription_tier, trial_ends_at) VALUES (?, ?, ?, datetime('now', ?))"
    ).run(wsName, userId, 'free', `+${TRIAL_DAYS} days`);
    const wsId = r.lastInsertRowid;
    const hasMember = db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(wsId, userId);
    if (!hasMember) {
      db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)').run(wsId, userId, 'owner');
    }
    return wsId;
  });
}

module.exports = { getUserCurrentWorkspace, getWorkspaceById, getUserRole, createPersonalWorkspace };
