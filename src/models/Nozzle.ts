import mongoose, { Schema, Document, Model } from "mongoose";

export interface INozzle extends Document {
  name: string;
  syncId: string | null;
  diameter: number;
  type: string;
  highFlow: boolean;
  hardened: boolean;
  notes: string;
  _deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const NozzleSchema = new Schema<INozzle>(
  {
    name: { type: String, required: true },
    syncId: { type: String, unique: true, sparse: true, index: true },
    // GH #337: positive diameters only — a 0 or negative nozzle diameter is
    // physically meaningless and silently corrupts volumetric / flow math
    // and slicer exports downstream.
    diameter: {
      type: Number,
      required: true,
      index: true,
      min: [0.01, "diameter must be greater than zero"],
    },
    type: { type: String, required: true, index: true },
    highFlow: { type: Boolean, default: false },
    hardened: { type: Boolean, default: false },
    notes: { type: String, default: "" },
    _deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Partial unique index: enforce unique names only among non-deleted documents
NozzleSchema.index(
  { name: 1 },
  { unique: true, partialFilterExpression: { _deletedAt: null } }
);

const Nozzle: Model<INozzle> =
  mongoose.models.Nozzle || mongoose.model<INozzle>("Nozzle", NozzleSchema);

export default Nozzle;
