// Membership is separate so upgrades preserve existing node IDs and encrypted keys.
module.exports = function installBoards(database) {
  database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS boards (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS board_nodes (
        node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
        board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_board_nodes_board ON board_nodes(board_id);
    `)
    database.prepare('INSERT OR IGNORE INTO boards (id, name, created_at) VALUES (?, ?, ?)').run('default', 'Network graph', new Date().toISOString())
    database.exec("INSERT OR IGNORE INTO board_nodes (node_id, board_id) SELECT id, 'default' FROM nodes")
  })()
}
