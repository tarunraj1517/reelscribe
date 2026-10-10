const mongoose = require("mongoose");

const ClipItemSchema = new mongoose.Schema(
  {
    title: { type: String, default: "" },
    reason: { type: String, default: "" },
    duration: { type: Number, default: 0 },
    url: { type: String, required: true },
    s3Key: { type: String, required: true },
    downloaded: { type: Boolean, default: false },
    // Once a clip is downloaded we schedule real S3 deletion 5 min later;
    // this timestamp lets the sweep job find it again even after a restart.
    downloadedAt: { type: Date, default: null },
    deleted: { type: Boolean, default: false },

    // ── AI metadata (virality score, hook, hashtags) ──
    score: { type: Number, default: null, min: 0, max: 100 },
    scoreNote: { type: String, default: "" },
    hook: { type: String, default: "" },
    description: { type: String, default: "" },
    hashtags: { type: [String], default: [] },

    // ── Editor support ──
    // sourceKey = caption-free master kept by the render service so a clip can be
    // trimmed / re-captioned later. Optional: older clips don't have it.
    sourceKey: { type: String, default: "" },
    editedFrom: { type: String, default: "" },
    captionSettings: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const ClipJobSchema = new mongoose.Schema(
  {
    userEmail: { type: String, required: true },
    ytUrl: { type: String, default: "" },
    ytTitle: { type: String, default: "" },
    sourceType: { type: String, enum: ["youtube", "instagram", "upload"], default: "youtube" },
    captionSettings: { type: mongoose.Schema.Types.Mixed, default: null },
    clips: { type: [ClipItemSchema], default: [] },
  },
  { timestamps: true }
);

// Fast per-user clip history queries (declared BEFORE compiling the model).
ClipJobSchema.index({ userEmail: 1, createdAt: -1 });
ClipJobSchema.index({ "clips.s3Key": 1 });

module.exports = mongoose.models.ClipJob || mongoose.model("ClipJob", ClipJobSchema);
