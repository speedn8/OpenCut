"use strict";
const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");

class JobQueue extends EventEmitter {
  constructor() { super(); this.waiting = []; this.entries = new Map(); this.active = undefined; this.closed = false; }
  publish(entry) { this.emit("job", structuredClone(entry.job)); }
  enqueue(type, operation) {
    if (this.closed) throw new Error("The native job queue is closing.");
    if (this.waiting.length >= 100) throw new Error("The native job queue is full. Wait for existing work or cancel a job.");
    const entry = { job: { id: randomUUID(), type, status: "queued", progress: 0 }, controller: new AbortController(), operation };
    this.entries.set(entry.job.id, entry); this.waiting.push(entry); this.publish(entry); setImmediate(() => this.drain());
    return structuredClone(entry.job);
  }
  internal(operation) {
    if (this.closed) return Promise.reject(new Error("The native job queue is closing."));
    if (this.waiting.length >= 100) return Promise.reject(new Error("The native job queue is full."));
    return new Promise((resolve, reject) => { this.waiting.push({ operation, controller: new AbortController(), resolve, reject }); queueMicrotask(() => this.drain()); });
  }
  async drain() {
    if (this.active || this.closed) return;
    const entry = this.waiting.shift(); if (!entry) return; this.active = entry;
    if (entry.job) { entry.job.status = "running"; this.publish(entry); }
    const update = (progress, message) => {
      if (!entry.job || entry.controller.signal.aborted || entry.terminal) return;
      entry.job.progress = Math.max(entry.job.progress, Math.min(0.99, Math.max(0, progress)));
      if (message) entry.job.message = String(message).slice(0, 1000);
      this.publish(entry);
    };
    try {
      const result = await entry.operation({ signal: entry.controller.signal, update });
      if (entry.controller.signal.aborted) throw new Error("Cancelled");
      if (entry.job) { Object.assign(entry.job, result || {}, { status: "completed", progress: 1 }); }
      else entry.resolve(result);
    } catch (error) {
      if (entry.job) { entry.job.status = entry.controller.signal.aborted ? "cancelled" : "failed"; entry.job.message = entry.controller.signal.aborted ? "Cancelled" : String(error.message || error).slice(0, 2000); }
      else entry.reject(error);
    } finally {
      entry.terminal = true;
      if (entry.job) this.publish(entry);
      // No API reads historical native payloads. Drop captured render plans and
      // large transcripts after delivery; keep only a small terminal tombstone.
      entry.operation = undefined; entry.resolve = undefined; entry.reject = undefined;
      if (entry.job) { const { id, type, status, progress, message } = entry.job; entry.job = { id, type, status, progress, ...(message ? { message } : {}) }; }
      if (this.entries.size > 256) for (const [id, previous] of this.entries) { if (this.entries.size <= 256) break; if (previous.terminal) this.entries.delete(id); }
      this.active = undefined; this.emit("idle"); queueMicrotask(() => this.drain());
    }
  }
  cancel(id) {
    const entry = this.entries.get(id); if (!entry) throw new Error("Unknown native job.");
    if (entry.terminal) return;
    entry.controller.abort(new Error("Cancelled by the editor"));
    if (this.active === entry) return;
    this.waiting = this.waiting.filter((item) => item !== entry);
    entry.terminal = true; entry.job.status = "cancelled"; entry.job.message = "Cancelled"; this.publish(entry);
  }
  async close() {
    this.closed = true;
    for (const entry of this.waiting.splice(0)) {
      entry.controller.abort(); entry.terminal = true;
      if (entry.job) { entry.job.status = "cancelled"; this.publish(entry); } else entry.reject(new Error("Application is closing."));
    }
    if (this.active) { this.active.controller.abort(); await new Promise((resolve) => this.once("idle", resolve)); }
  }
}
module.exports = { JobQueue };
