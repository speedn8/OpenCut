"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

class StorageConflictError extends Error {
  constructor() { super("This project changed in storage. Reopen it before saving to avoid overwriting another revision."); this.code = "STORAGE_CONFLICT"; }
}
const validId = (id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(id);
function requireId(id) { if (!validId(id)) throw new Error("Invalid opaque identifier."); return id; }

class ProjectDatabase {
  constructor(directory, core) {
    fs.mkdirSync(directory, { recursive: true });
    this.core = core;
    this.db = new DatabaseSync(path.join(directory, "state.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at TEXT NOT NULL, storage_version INTEGER NOT NULL, duration INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions(project_id TEXT NOT NULL REFERENCES projects(id), storage_version INTEGER NOT NULL, core_revision INTEGER NOT NULL, saved_at TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(project_id,storage_version));
      CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY, payload TEXT NOT NULL);`);
  }
  validate(value) {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== "string" || Buffer.byteLength(encoded) > 16 * 1024 * 1024) throw new Error("Project exceeds the 16 MiB native save boundary.");
    const project = this.core.validateProject(JSON.parse(encoded));
    requireId(project.id);
    return project;
  }
  list() {
    return this.db.prepare("SELECT id,name,updated_at AS updatedAt,storage_version AS version,duration FROM projects ORDER BY updated_at DESC,id").all();
  }
  open(id) {
    const row = this.db.prepare("SELECT payload,storage_version FROM projects WHERE id=?").get(requireId(id));
    if (!row) throw new Error("Project was not found in this profile.");
    return { project: this.validate(JSON.parse(row.payload)), version: row.storage_version };
  }
  save({ project: input, expectedVersion }) {
    if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) throw new Error("Expected storage version must be null or a positive integer.");
    const project = this.validate(input);
    const duration = this.core.projectDuration(project);
    if (!Number.isSafeInteger(duration) || duration < 0) throw new Error("Invalid project duration.");
    const payload = JSON.stringify(project);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT storage_version FROM projects WHERE id=?").get(project.id);
      if ((existing && expectedVersion !== existing.storage_version) || (!existing && expectedVersion !== null)) throw new StorageConflictError();
      const version = (existing?.storage_version || 0) + 1;
      this.db.prepare(`INSERT INTO projects(id,name,updated_at,storage_version,duration,payload) VALUES(?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at,storage_version=excluded.storage_version,duration=excluded.duration,payload=excluded.payload`).run(project.id, project.name, project.updatedAt, version, duration, payload);
      this.db.prepare("INSERT INTO revisions(project_id,storage_version,core_revision,saved_at,payload) VALUES(?,?,?,?,?)").run(project.id, version, project.revision, new Date().toISOString(), payload);
      this.db.exec("COMMIT");
      return { version };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  addMedia(record) { this.db.prepare("INSERT INTO media(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(requireId(record.id), JSON.stringify(record)); }
  getMedia(id) {
    const row = this.db.prepare("SELECT payload FROM media WHERE id=?").get(requireId(id));
    if (!row) throw new Error("This media is not registered in the current profile.");
    return JSON.parse(row.payload);
  }
  allMedia() { return this.db.prepare("SELECT payload FROM media").all().map((row) => JSON.parse(row.payload)); }
  close() { this.db.close(); }
}
module.exports = { ProjectDatabase, StorageConflictError, requireId, validId };
