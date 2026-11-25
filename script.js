"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.join(__dirname, "data");
const BOOKINGS_FILE = path.join(DATA_DIR, "bookings.json");
const MESSAGES_FILE = path.join(DATA_DIR, "messages.json");
const MAX_PER_SLOT = 3;

const STATIC = {
  "/": "index.html",
  "/index.html": "index.html",
  "/style.css": "style.css",
  "/script.js": "script.js"
};
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};

const SLOTS = [];
for (let h = 9; h <= 19; h++) {
  ["00", "30"].forEach(m => {
    if (h === 19 && m === "30") return;
    SLOTS.push(String(h).padStart(2, "0") + ":" + m);
  });
}

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { return fallback; }
}
function saveJson(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const services = loadJson(path.join(__dirname, "services.json"), []);
let bookings = loadJson(BOOKINGS_FILE, []);
let messages = loadJson(MESSAGES_FILE, []);

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ "X-Content-Type-Options": "nosniff" }, headers));
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
}
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 20000) {
        reject({ status: 413, message: "Request is too large." });
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); }
      catch (e) { reject({ status: 400, message: "Invalid request." }); }
    });
    req.on("error", () => reject({ status: 400, message: "Invalid request." }));
  });
}

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const validEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

function todayString() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
const publicBooking = b => ({ id: b.id, service: b.service, date: b.date, time: b.time });

function createBooking(body) {
  const name = str(body.name, 80);
  const email = str(body.email, 120).toLowerCase();
  const phone = str(body.phone, 30);
  const notes = str(body.notes, 300);
  const date = str(body.date, 10);
  const time = str(body.time, 5);
  const service = services.find(s => s.id === body.service);

  if (name.length < 2) throw { status: 400, message: "Please enter your full name." };
  if (!validEmail(email)) throw { status: 400, message: "Please enter a valid email." };
  if (!/^[0-9+()\-\s]{7,30}$/.test(phone)) throw { status: 400, message: "Please enter a valid phone number." };
  if (!service) throw { status: 400, message: "Please choose a service." };
  if (!validDate(date) || date < todayString()) throw { status: 400, message: "Please choose a valid date from today onward." };
  if (!SLOTS.includes(time)) throw { status: 400, message: "Please choose a time between 9:00 AM and 7:00 PM." };

  const sameSlot = bookings.filter(b => b.date === date && b.time === time);
  if (sameSlot.some(b => b.email === email)) throw { status: 409, message: "You already have a booking at that time." };
  if (sameSlot.length >= MAX_PER_SLOT) throw { status: 409, message: "That time is fully booked. Please pick another." };

  const booking = {
    id: crypto.randomUUID(),
    serviceId: service.id,
    service: service.name,
    price: service.price,
    date, time, name, email, phone, notes,
    createdAt: new Date().toISOString()
  };
  bookings.push(booking);
  saveJson(BOOKINGS_FILE, bookings);
  return booking;
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  if (p === "/api/services" && method === "GET") return sendJson(res, 200, services);

  let m = p.match(/^\/api\/services\/([\w-]+)$/);
  if (m && method === "GET") {
    const s = services.find(x => x.id === m[1]);
    return s ? sendJson(res, 200, s) : sendJson(res, 404, { error: "Service not found." });
  }

  if (p === "/api/bookings" && method === "POST") {
    const b = createBooking(await readJsonBody(req));
    return sendJson(res, 201, {
      message: "Booked! " + b.service + " on " + b.date + " at " + b.time + ". See you at SpaRing.",
      booking: publicBooking(b)
    });
  }

  if (p === "/api/bookings" && method === "GET") {
    const email = str(url.searchParams.get("email"), 120).toLowerCase();
    if (!validEmail(email)) return sendJson(res, 400, { error: "Please enter a valid email." });
    const list = bookings
      .filter(b => b.email === email)
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
      .map(publicBooking);
    return sendJson(res, 200, list);
  }

  m = p.match(/^\/api\/bookings\/([\w-]+)$/);
  if (m && method === "DELETE") {
    const email = str(url.searchParams.get("email"), 120).toLowerCase();
    const i = bookings.findIndex(b => b.id === m[1] && b.email === email);
    if (i === -1) return sendJson(res, 404, { error: "Booking not found." });
    bookings.splice(i, 1);
    saveJson(BOOKINGS_FILE, bookings);
    return sendJson(res, 200, { message: "Your booking has been cancelled." });
  }

  if (p === "/api/messages" && method === "POST") {
    const body = await readJsonBody(req);
    const name = str(body.name, 80);
    const email = str(body.email, 120);
    const message = str(body.message, 1000);
    if (!name || !validEmail(email) || !message) {
      return sendJson(res, 400, { error: "Please fill in your name, a valid email and a message." });
    }
    messages.push({ id: crypto.randomUUID(), name, email, message, createdAt: new Date().toISOString() });
    saveJson(MESSAGES_FILE, messages);
    return sendJson(res, 201, { message: "Thank you! We received your message and will reply soon." });
  }

  return sendJson(res, 404, { error: "Not found." });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);

    const file = STATIC[url.pathname];
    if (!file || (req.method !== "GET" && req.method !== "HEAD")) {
      return send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
    }
    fs.readFile(path.join(__dirname, file), (err, data) => {
      if (err) return send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
      send(res, 200, data, { "Content-Type": TYPES[path.extname(file)], "Cache-Control": "no-cache" });
    });
  } catch (e) {
    if (e && e.status) return sendJson(res, e.status, { error: e.message });
    console.error(e);
    sendJson(res, 500, { error: "Something went wrong." });
  }
});

server.listen(PORT, () => console.log("SpaRing running at http://localhost:" + PORT));
