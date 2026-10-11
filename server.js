const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_DAYS = 7;
const dbDir = path.join(__dirname, "data");
require("fs").mkdirSync(dbDir, { recursive: true });
const db = new Database(path.join(dbDir, "nextstep.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('learner','organization','academy')),
  interests TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS opportunities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('Online','Offline','Hybrid')),
  location TEXT NOT NULL DEFAULT '',
  start_date TEXT NOT NULL,
  deadline TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS bookmarks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opportunity_id INTEGER NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, opportunity_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
`);

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: null
    }
  }
}));
app.use(express.json({ limit: "30kb" }));
app.use(express.urlencoded({ extended: false, limit: "30kb" }));
app.use("/api/", rateLimit({ windowMs: 15 * 60 * 1000, limit: 180, standardHeaders: true, legacyHeaders: false }));

const COOKIE_NAME = "nextstep_session";
function createSession(userId, res) {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  db.prepare("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)").run(tokenHash, userId, expiresAt);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: "/"
  });
}
function getUser(req) {
  const token = req.headers.cookie?.split(";").map(s => s.trim()).find(s => s.startsWith(COOKIE_NAME + "="))?.slice(COOKIE_NAME.length + 1);
  if (!token) return null;
  let decoded;
  try { decoded = decodeURIComponent(token); } catch { return null; }
  const tokenHash = crypto.createHash("sha256").update(decoded).digest("hex");
  const session = db.prepare(`SELECT users.id, users.name, users.email, users.role, users.interests, sessions.expires_at
    FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=?`).get(tokenHash);
  if (!session || session.expires_at < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash);
    return null;
  }
  return { id: session.id, name: session.name, email: session.email, role: session.role, interests: JSON.parse(session.interests || "[]") };
}
function requireAuth(req, res, next) {
  const user = getUser(req);
  if (!user) return res.status(401).json({ error: "Please log in to continue." });
  req.user = user;
  next();
}
function requirePublisher(req, res, next) {
  if (!["organization", "academy"].includes(req.user.role)) return res.status(403).json({ error: "Only organizations and academies can publish opportunities." });
  next();
}
function cleanText(value, max = 500) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function serializeOpportunity(row, userId = 0) {
  return {
    id: row.id, title: row.title, type: row.type, subject: row.subject,
    description: row.description, mode: row.mode, location: row.location,
    startDate: row.start_date, deadline: row.deadline, url: row.url,
    imageUrl: row.image_url, creator: row.creator_name,
    creatorId: row.creator_id, bookmarked: Boolean(row.bookmarked),
    createdAt: row.created_at
  };
}
const opportunitySelect = `
SELECT o.*, u.name AS creator_name,
CASE WHEN b.user_id IS NULL THEN 0 ELSE 1 END AS bookmarked
FROM opportunities o JOIN users u ON u.id=o.creator_id
LEFT JOIN bookmarks b ON b.opportunity_id=o.id AND b.user_id=?`;

app.get("/api/me", (req, res) => {
  const user = getUser(req);
  res.json({ user });
});
app.post("/api/signup", async (req, res) => {
  const name = cleanText(req.body.name, 80);
  const email = cleanText(req.body.email, 160).toLowerCase();
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const role = cleanText(req.body.role, 20);
  const interests = Array.isArray(req.body.interests) ? req.body.interests.filter(v => typeof v === "string").slice(0, 10) : [];
  if (name.length < 2) return res.status(400).json({ error: "Enter a name with at least 2 characters." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  if (!["learner", "organization", "academy"].includes(role)) return res.status(400).json({ error: "Choose a valid account type." });
  const passwordHash = await bcrypt.hash(password, 12);
  try {
    const result = db.prepare("INSERT INTO users (name,email,password_hash,role,interests) VALUES (?,?,?,?,?)")
      .run(name, email, passwordHash, role, JSON.stringify(interests));
    createSession(result.lastInsertRowid, res);
    res.status(201).json({ user: { id: result.lastInsertRowid, name, email, role, interests } });
  } catch (err) {
    if (String(err.code).includes("SQLITE_CONSTRAINT_UNIQUE")) return res.status(409).json({ error: "An account with this email already exists." });
    console.error(err);
    res.status(500).json({ error: "Could not create your account." });
  }
});
app.post("/api/login", async (req, res) => {
  const email = cleanText(req.body.email, 160).toLowerCase();
  const password = typeof req.body.password === "string" ? req.body.password : "";
  const user = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: "Email or password is incorrect." });
  createSession(user.id, res);
  res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role, interests: JSON.parse(user.interests || "[]") } });
});
app.post("/api/logout", (req, res) => {
  const token = req.headers.cookie?.split(";").map(s => s.trim()).find(s => s.startsWith(COOKIE_NAME + "="))?.slice(COOKIE_NAME.length + 1);
  if (token) {
    const tokenHash = crypto.createHash("sha256").update(decodeURIComponent(token)).digest("hex");
    db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash);
  }
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  res.json({ ok: true });
});

app.get("/api/opportunities", (req, res) => {
  const user = getUser(req);
  const search = cleanText(req.query.search, 100);
  const type = cleanText(req.query.type, 30);
  const subject = cleanText(req.query.subject, 50);
  const mode = cleanText(req.query.mode, 20);
  const location = cleanText(req.query.location, 80);
  const where = [];
  const params = [user?.id || 0];
  if (search) { where.push("(o.title LIKE ? OR o.description LIKE ? OR o.subject LIKE ? OR u.name LIKE ?)"); params.push(...Array(4).fill(`%${search}%`)); }
  if (type && type !== "All types") { where.push("o.type=?"); params.push(type); }
  if (subject && subject !== "All subjects") { where.push("o.subject=?"); params.push(subject); }
  if (mode && mode !== "Any format") { where.push("o.mode=?"); params.push(mode); }
  if (location) { where.push("(o.location LIKE ? OR o.mode='Online')"); params.push(`%${location}%`); }
  const sql = opportunitySelect + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY o.start_date ASC LIMIT 100";
  const rows = db.prepare(sql).all(...params);
  res.json({ opportunities: rows.map(r => serializeOpportunity(r, user?.id)) });
});
app.get("/api/opportunities/:id", (req, res) => {
  const user = getUser(req);
  const row = db.prepare(opportunitySelect + " WHERE o.id=?").get(user?.id || 0, Number(req.params.id));
  if (!row) return res.status(404).json({ error: "Opportunity not found." });
  res.json({ opportunity: serializeOpportunity(row) });
});
app.post("/api/opportunities", requireAuth, requirePublisher, (req, res) => {
  const title = cleanText(req.body.title, 120);
  const type = cleanText(req.body.type, 30);
  const subject = cleanText(req.body.subject, 50);
  const description = cleanText(req.body.description, 2000);
  const mode = cleanText(req.body.mode, 20);
  const location = cleanText(req.body.location, 100);
  const startDate = cleanText(req.body.startDate, 10);
  const deadline = cleanText(req.body.deadline, 10);
  const url = cleanText(req.body.url, 500);
  const imageUrl = cleanText(req.body.imageUrl, 500);
  if (!title || !subject || !description || !startDate || !deadline) return res.status(400).json({ error: "Fill in all required fields." });
  if (!["Course","Workshop","Competition","Event","Volunteering","Scholarship","Other"].includes(type)) return res.status(400).json({ error: "Choose a valid opportunity type." });
  if (!["Online","Offline","Hybrid"].includes(mode)) return res.status(400).json({ error: "Choose a valid format." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(deadline) || deadline > startDate) return res.status(400).json({ error: "Check the dates: deadline must be on or before the start date." });
  for (const link of [url, imageUrl]) if (link && !/^https:\/\/[^\s]+$/i.test(link)) return res.status(400).json({ error: "Links must start with https://." });
  const result = db.prepare(`INSERT INTO opportunities (title,type,subject,description,mode,location,start_date,deadline,url,image_url,creator_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(title,type,subject,description,mode,location,startDate,deadline,url,imageUrl,req.user.id);
  const row = db.prepare(opportunitySelect + " WHERE o.id=?").get(req.user.id, result.lastInsertRowid);
  res.status(201).json({ opportunity: serializeOpportunity(row) });
});
app.delete("/api/opportunities/:id", requireAuth, (req, res) => {
  const result = db.prepare("DELETE FROM opportunities WHERE id=? AND creator_id=?").run(Number(req.params.id), req.user.id);
  if (!result.changes) return res.status(404).json({ error: "Opportunity not found or you do not own it." });
  res.json({ ok: true });
});
app.get("/api/bookmarks", requireAuth, (req, res) => {
  const rows = db.prepare(opportunitySelect + " JOIN bookmarks mine ON mine.opportunity_id=o.id AND mine.user_id=? ORDER BY mine.created_at DESC")
    .all(req.user.id, req.user.id);
  res.json({ opportunities: rows.map(r => serializeOpportunity(r)) });
});
app.post("/api/opportunities/:id/bookmark", requireAuth, (req, res) => {
  if (req.user.role !== "learner") return res.status(403).json({ error: "Bookmarks are available for learner accounts." });
  const id = Number(req.params.id);
  if (!db.prepare("SELECT id FROM opportunities WHERE id=?").get(id)) return res.status(404).json({ error: "Opportunity not found." });
  const exists = db.prepare("SELECT 1 FROM bookmarks WHERE user_id=? AND opportunity_id=?").get(req.user.id, id);
  if (exists) db.prepare("DELETE FROM bookmarks WHERE user_id=? AND opportunity_id=?").run(req.user.id, id);
  else db.prepare("INSERT INTO bookmarks (user_id,opportunity_id) VALUES (?,?)").run(req.user.id, id);
  res.json({ bookmarked: !exists });
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.listen(PORT, () => console.log(`NextStep is running at http://localhost:${PORT}`));
