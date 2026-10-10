const mongoose = require("mongoose");

// One kit per owner. A team owner's kit is automatically applied to every active team member.
const BrandKitSchema = new mongoose.Schema(
  {
    ownerEmail: { type: String, required: true, unique: true, lowercase: true, trim: true },
    brandName: { type: String, default: "", maxlength: 60 },
    handle: { type: String, default: "", maxlength: 40 },          // e.g. @reelscribe
    primaryColor: { type: String, default: "#8b5cf6" },
    accentColor: { type: String, default: "#ec4899" },
    fontName: { type: String, default: "" },
    logoUrl: { type: String, default: "" },
    logoKey: { type: String, default: "" },
    logoPosition: { type: String, enum: ["top-left", "top-right", "bottom-left", "bottom-right"], default: "top-right" },
    logoEnabled: { type: Boolean, default: true },
    outroText: { type: String, default: "", maxlength: 80 },
  },
  { timestamps: true }
);

module.exports = mongoose.models.BrandKit || mongoose.model("BrandKit", BrandKitSchema);
