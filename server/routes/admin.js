import { Router } from "express";
import { findUserById, listUsers, deleteUserById } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

/** Reserved for administrators (first account created, or email = ADMIN_EMAIL). */
function requireAdmin(req, res, next) {
  const user = findUserById.get(req.userId);
  if (!user || user.role !== "admin") return res.status(403).json({ error: "FORBIDDEN" });
  req.adminUser = user;
  next();
}
router.use(requireAdmin);

/** List users with aggregated statistics. */
router.get("/users", (req, res) => {
  res.json({ users: listUsers.all() });
});

/** Delete a user (never yourself, never another admin). */
router.delete("/users/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "INVALID_ID" });
  if (id === req.userId) return res.status(400).json({ error: "CANNOT_DELETE_SELF" });
  const target = findUserById.get(id);
  if (!target) return res.status(404).json({ error: "NOT_FOUND" });
  if (target.role === "admin") return res.status(403).json({ error: "CANNOT_DELETE_ADMIN" });
  deleteUserById.run(id);
  res.json({ ok: true, users: listUsers.all() });
});

export default router;
