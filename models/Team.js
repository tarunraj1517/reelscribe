const mongoose = require("mongoose");

const MemberSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    role: { type: String, enum: ["member"], default: "member" },
    status: { type: String, enum: ["invited", "active"], default: "invited" },
    invitedAt: { type: Date, default: Date.now },
    joinedAt: { type: Date, default: null },
  },
  { _id: false }
);

const TeamSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, maxlength: 60 },
    ownerEmail: { type: String, required: true, unique: true, lowercase: true, trim: true },
    members: { type: [MemberSchema], default: [] },
  },
  { timestamps: true }
);

TeamSchema.index({ "members.email": 1 });

module.exports = mongoose.models.Team || mongoose.model("Team", TeamSchema);
