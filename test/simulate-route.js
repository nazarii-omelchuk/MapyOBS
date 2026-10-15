#!/usr/bin/env node
/*
 * Штучний тест GPS-маршруту для віджету MapyOBS.
 *
 * Піднімає фейковий Traccar, який віддає рух пристрою вздовж
 * дорожнього маршруту "Куліша 7 (Київ) -> Гнат Юри 10 (Київ)",
 * створює віджет у головному сервері та друкує посилання для OBS.
 *
 * Запуск (головний сервер має працювати — npm start):
 *   node test/simulate-route.js
 *
 * Налаштування через змінні середовища:
 *   SIM_PORT=8083      порт фейкового Traccar
 *   SIM_SPEED_KMH=30   швидкість руху (км/год)
 *   SIM_TIME_SCALE=8   прискорення симуляційного часу
 *   SIM_SAMPLE_STEP=2  крок точок історії (симульованих секунд)
 *   SIM_LOOP=1         рухатись туди-назад безкінечно
 *   SIM_FOLLOW=0       камера не слідкує за GPS-маркером
 *   SIM_ZOOM=16        зум карти (3–19)
 *   SIM_CENTER=lat,lon фіксований центр карти
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i < 0) continue;
    const key = s.slice(0, i).trim();
    const value = s.slice(i + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv();

const MAIN_URL = (process.env.MAIN_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const SIM_PORT = Number(process.env.SIM_PORT || 8083);
const DEVICE_UID = process.env.SIM_DEVICE_UID || "testgps";
const DEVICE_NAME = process.env.SIM_DEVICE_NAME || "Тестовий маршрут";
const AUTH_USER = "test";
const AUTH_PASS = "test";
const SPEED_KMH = Number(process.env.SIM_SPEED_KMH || 14);
const TIME_SCALE = Number(process.env.SIM_TIME_SCALE || 8);
const SAMPLE_STEP = Number(process.env.SIM_SAMPLE_STEP || 1);
const LOOP = process.env.SIM_LOOP === "1";
const HISTORY_HOURS = 24;

const VIEW_FOLLOW = process.env.SIM_FOLLOW !== "0";
const VIEW_ZOOM = Number(process.env.SIM_ZOOM || 16);
const VIEW_CENTER = process.env.SIM_CENTER || "";

const START_ADDRESS = "вулиця Куліша 7, Київ, Україна";
const END_ADDRESS = "вулиця Гната Юри 10, Київ, Україна";

async function fetchJson(url, init) {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.json();
}

async function geocode(address) {
  try {
    const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" +
      encodeURIComponent(address);
    const data = await fetchJson(url, {
      headers: { "User-Agent": "MapyOBS-simulate/1.0" }
    });
    if (data && data.length) {
      return {
        lat: Number(data[0].lat),
        lon: Number(data[0].lon),
        label: data[0].display_name
      };
    }
  } catch (e) {
    console.warn("Nominatim недоступний:", e.message);
  }

  const key = process.env.MAPY_API_KEY || "";
  if (!key) throw new Error(`Не вдалося геокодувати адресу: ${address}`);
  const url = "https://api.mapy.com/v1/geocode/?limit=1&lang=uk&apikey=" +
    encodeURIComponent(key) + "&query=" + encodeURIComponent(address);
  const data = await fetchJson(url);
  const item = data && data.items && data.items[0];
  if (!item) throw new Error(`Не знайдено адресу: ${address}`);
  return {
    lat: item.position.lat,
    lon: item.position.lon,
    label: item.label || address
  };
}

async function fetchRoute(start, end) {
  const coords = `${start.lon},${start.lat};${end.lon},${end.lat}`;

  for (const base of [
    "https://router.project-osrm.org",
    "http://router.project-osrm.org"
  ]) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const url = `${base}/route/v1/driving/${coords}` +
          "?overview=full&geometries=geojson&steps=false";
        const data = await fetchJson(url, {
          headers: { "User-Agent": "MapyOBS-simulate/1.0" }
        });
        const points = data && data.routes &&
          data.routes[0] && data.routes[0].geometry.coordinates;
        if (points && points.length > 1) {
          return points.map(c => ({ lon: c[0], lat: c[1] }));
        }
        throw new Error("порожня відповідь OSRM");
      } catch (e) {
        console.warn(`OSRM спроба ${attempt} невдала: ${e.message}`);
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, 1500));
        }
      }
    }
  }

  console.warn("Будую прямий відрізок між адресами");
  const n = 200;
  const points = [];
  for (let i = 0; i <= n; i++) {
    points.push({
      lat: start.lat + (end.lat - start.lat) * (i / n),
      lon: start.lon + (end.lon - start.lon) * (i / n)
    });
  }
  return points;
}

const EARTH_R = 6371000;
const rad = d => d * Math.PI / 180;

function haversine(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(s));
}

function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function buildPath(points) {
  const cum = [0];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversine(points[i - 1], points[i]);
    cum.push(total);
  }
  return { points, cum, total };
}

function positionAt(pathInfo, meters) {
  const pts = pathInfo.points;
  const cum = pathInfo.cum;

  if (meters <= 0) {
    return {
      lat: pts[0].lat,
      lon: pts[0].lon,
      course: bearing(pts[0], pts[1] || pts[0])
    };
  }
  if (meters >= pathInfo.total) {
    const n = pts.length - 1;
    return {
      lat: pts[n].lat,
      lon: pts[n].lon,
      course: bearing(pts[n - 1] || pts[n], pts[n])
    };
  }

  let i = 1;
  while (i < cum.length && cum[i] < meters) i++;
  const seg = cum[i] - cum[i - 1];
  const t = seg > 0 ? (meters - cum[i - 1]) / seg : 0;
  const a = pts[i - 1];
  const b = pts[i];
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + (b.lon - a.lon) * t,
    course: bearing(a, b)
  };
}

let pathInfo = null;
let t0 = Date.now();
const SPEED_MS = SPEED_KMH / 3.6;

function traveledMeters() {
  const elapsed = (Date.now() - t0) / 1000 * TIME_SCALE;
  let dist = SPEED_MS * elapsed;

  if (LOOP && pathInfo && pathInfo.total > 0) {
    const period = 2 * pathInfo.total;
    const phase = dist % period;
    dist = phase <= pathInfo.total ? phase : period - phase;
  }
  return dist;
}

function currentPosition() {
  return positionAt(pathInfo, traveledMeters());
}

function traccarPosition(pos, time) {
  return {
    id: 1,
    deviceId: 1,
    protocol: "simulate",
    deviceTime: time,
    fixTime: time,
    serverTime: time,
    latitude: pos.lat,
    longitude: pos.lon,
    altitude: 180,
    speed: SPEED_KMH / 1.852,
    course: pos.course,
    accuracy: 5,
    valid: true
  };
}

function historyPoints() {
  const stepMeters = SPEED_MS * SAMPLE_STEP;
  const traveled = traveledMeters();
  const count = Math.min(Math.floor(traveled / stepMeters), 5000);
  const out = [];

  for (let i = 0; i <= count; i++) {
    const pos = positionAt(pathInfo, i * stepMeters);
    const time = new Date(
      t0 + (i * SAMPLE_STEP / TIME_SCALE) * 1000
    ).toISOString();
    out.push(traccarPosition(pos, time));
  }
  return out;
}

const fakeTraccar = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const auth = String(req.headers.authorization || "");

  const send = (obj, code) => {
    res.writeHead(code || 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (!auth.startsWith("Basic ")) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="simulate"' });
    return res.end(JSON.stringify({ message: "Unauthorized" }));
  }

  const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  if (decoded.slice(0, sep) !== AUTH_USER ||
      decoded.slice(sep + 1) !== AUTH_PASS) {
    return send({ message: "Unauthorized" }, 401);
  }

  if (url.pathname === "/api/session") {
    return send({
      id: 1,
      name: AUTH_USER,
      email: AUTH_USER + "@simulate",
      administrator: true,
      readonly: false
    });
  }

  if (url.pathname === "/api/devices") {
    return send([{
      id: 1,
      name: DEVICE_NAME,
      uniqueId: DEVICE_UID,
      status: "online",
      disabled: false,
      lastUpdate: new Date().toISOString(),
      positionId: 1,
      groupId: 0,
      attributes: {}
    }]);
  }

  if (url.pathname === "/api/positions") {
    const pos = currentPosition();
    const now = new Date().toISOString();
    if (url.searchParams.get("deviceId")) {
      return send(historyPoints());
    }
    return send([traccarPosition(pos, now)]);
  }

  send({ message: "Not Found" }, 404);
});

let widgetToken = null;

async function deleteWidget(token) {
  try {
    await fetch(
      `${MAIN_URL}/api/widgets/${encodeURIComponent(token)}`,
      { method: "DELETE" }
    );
  } catch (e) {
    console.warn("Не вдалося видалити тест-віджет:", e.message);
  }
}

async function main() {
  console.log("Геокодую адреси...");
  const start = await geocode(START_ADDRESS);
  const end = await geocode(END_ADDRESS);
  console.log(`  Старт:  ${start.label}  (${start.lat}, ${start.lon})`);
  console.log(`  Фініш:  ${end.label}  (${end.lat}, ${end.lon})`);

  console.log("Будую дорожній маршрут...");
  const routePoints = await fetchRoute(start, end);
  pathInfo = buildPath(routePoints);
  console.log(
    `  Довжина: ${(pathInfo.total / 1000).toFixed(2)} км, ` +
    `точок: ${routePoints.length}`
  );

  t0 = Date.now();

  try {
    await new Promise((resolve, reject) => {
      fakeTraccar.once("error", reject);
      fakeTraccar.listen(SIM_PORT, "127.0.0.1", resolve);
    });
  } catch (e) {
    if (e.code === "EADDRINUSE") {
      throw new Error(
        `Порт ${SIM_PORT} зайнятий — можливо, симуляція вже запущена`
      );
    }
    throw e;
  }
  console.log(`Фейковий Traccar: http://127.0.0.1:${SIM_PORT}`);

  let widgets;
  try {
    const data = await fetchJson(MAIN_URL + "/api/widgets");
    widgets = data.widgets || [];
  } catch (e) {
    throw new Error("Головний сервер не запущений. Виконай: npm start");
  }

  for (const w of widgets) {
    if (w.identifier === DEVICE_UID) {
      await deleteWidget(w.token);
      console.log(`Видалено старий тест-віджет: ${w.token}`);
    }
  }

  const res = await fetch(MAIN_URL + "/api/widgets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      baseUrl: `http://127.0.0.1:${SIM_PORT}`,
      username: AUTH_USER,
      password: AUTH_PASS,
      identifier: DEVICE_UID,
      hours: HISTORY_HOURS,
      follow: VIEW_FOLLOW,
      zoom: VIEW_ZOOM,
      center: VIEW_CENTER
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Не вдалося створити тест-віджет");
  }

  widgetToken = data.widget.token;
  const url = new URL(data.widget.overlayUrl, MAIN_URL).href;
  const tripMinutes = pathInfo.total / 1000 / SPEED_KMH * 60 / TIME_SCALE;

  console.log("");
  console.log(`Тест-віджет створено: ${data.widget.deviceName}`);
  console.log(`OBS-посилання: ${url}`);
  console.log("");
  console.log(
    `Симуляція: ${SPEED_KMH} км/год, x${TIME_SCALE} часу — ` +
    `маршрут пройдеться за ~${tripMinutes.toFixed(1)} хв`
  );
  console.log(
    "Камера: " + (VIEW_FOLLOW
      ? "слідкує за GPS-маркером"
      : VIEW_CENTER
        ? `фіксована (центр ${VIEW_CENTER}, зум ${VIEW_ZOOM})`
        : "не слідкує — вміщує весь маршрут")
  );
  console.log("Зупинити симуляцію: Ctrl+C");
}

main()
  .then(() => {
    const stop = () => {
      console.log("\nСимуляцію зупинено.");
      fakeTraccar.close(() => {
        if (widgetToken) deleteWidget(widgetToken);
        process.exit(0);
      });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  })
  .catch(e => {
    console.error("Помилка:", e.message);
    process.exit(1);
  });
