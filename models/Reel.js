const mongoose = require("mongoose");

const SegmentSchema = new mongoose.Schema(
  { start: Number, end: Number, text: String },
  { _id: false }
);

const ReelSchema = new mongoose.Schema(
  {
    userEmail: { type: String, required: true },
    reelUrl: { type: String, default: "" },
    transcript: { type: String, required: true },
    // Timed segments (seconds) — powers SRT/VTT export and translated subtitles.
    segments: { type: [SegmentSchema], default: [] },
    language: { type: String, default: "" },
    source: { type: String, default: "" },
    // Cached AI outputs (summary, chapters, translations, repurposed content)
    // so the same request never costs a second LLM call.
    aiCache: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

// NOTE: indexes must be declared BEFORE the model is compiled, otherwise Mongoose ignores them.
ReelSchema.index({ userEmail: 1, createdAt: -1 });

module.exports = mongoose.models.Reel || mongoose.model("Reel", ReelSchema);
