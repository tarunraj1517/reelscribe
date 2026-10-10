const mongoose = require("mongoose");

// Clip job state used to live in an in-memory Map, so every Render restart/deploy
// silently lost running jobs. Persisting it makes /clip-status reliable.
const JobStateSchema = new mongoose.Schema(
  {
    jobId: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true, index: true },
    status: { type: String, enum: ["processing", "done", "error"], default: "processing" },
    error: { type: String, default: "" },
    clips: { type: [mongoose.Schema.Types.Mixed], default: [] },
    historyId: { type: String, default: "" },
    via: { type: String, default: "web" }, // web | api
    reservedKind: { type: String, default: "" },   // "clip" = a plan clip was reserved (refunded on failure), "referral" = referral cut
    ownerId: { type: String, default: "" },        // which server instance runs the job
    heartbeatAt: { type: Date, default: Date.now },// running instances refresh this; stale = job was lost in a restart
    webhookNotified: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now, expires: 2 * 60 * 60 }, // TTL: auto-removed after 2h
  },
  { minimize: false }
);

module.exports = mongoose.models.JobState || mongoose.model("JobState", JobStateSchema);
