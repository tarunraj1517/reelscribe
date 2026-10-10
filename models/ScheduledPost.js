const mongoose = require("mongoose");

const ScheduledPostSchema = new mongoose.Schema(
  {
    userEmail: { type: String, required: true, index: true, lowercase: true, trim: true },
    historyId: { type: String, required: true },
    clipIndex: { type: Number, required: true, min: 0 },
    clipTitle: { type: String, default: "" },
    platform: { type: String, enum: ["youtube", "instagram", "tiktok", "x", "linkedin", "facebook"], required: true },
    caption: { type: String, default: "", maxlength: 2200 },
    scheduledAt: { type: Date, required: true, index: true },
    clipExpiresAt: { type: Date, required: true },
    status: { type: String, enum: ["scheduled", "reminded", "cancelled", "failed"], default: "scheduled", index: true },
    remindedAt: { type: Date, default: null },
    error: { type: String, default: "" },
  },
  { timestamps: true }
);

module.exports = mongoose.models.ScheduledPost || mongoose.model("ScheduledPost", ScheduledPostSchema);
