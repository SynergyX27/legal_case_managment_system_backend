import { workspace } from "../models/workspace.model.js";
export const getWorkspace = async (req, res) =>
  res.json(await workspace(req.user));
