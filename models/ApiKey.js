const mongoose = require("mongoose");

const ApiKeySchema = new mongoose.Schema(
  {
    userEmail: { type: String, required: true, index: true, lowercase: true, trim: true },
    name: { type: String, default: "My key", maxlength: 60 },
    prefix: { type: String, required: true },           // first chars, shown in the UI
    hash: { type: String, required: true, unique: true }, // sha256 of the full key — the key itself is never stored
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.models.ApiKey || mongoose.model("ApiKey", ApiKeySchema);
