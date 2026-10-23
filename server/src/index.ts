import http from 'http';
import express from 'express';
import cors from 'cors';
import colyseusPkg from 'colyseus';
import wsTransportPkg from '@colyseus/ws-transport';
import {
  RiftRoom,
  activeRoomsByCode,
  getServerTickLagP95Ms,
} from './rooms/RiftRoom.js';

const { Server } = colyseusPkg;
const { WebSocketTransport } = wsTransportPkg;

const PORT = Number(process.env.PORT || 2567);
const NODE_ENV = process.env.NODE_ENV || 'development';

const defaultOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
];

const configuredOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const allowedOrigins = new Set([...defaultOrigins, ...configuredOrigins]);

// Pre-compile strict Netlify deploy-preview regexes ONLY for explicitly configured Netlify site names
const netlifyPreviewPatterns: RegExp[] = [];
for (const orig of configuredOrigins) {
  const m = /^https:\/\/([a-z0-9-]+)\.netlify\.app$/i.exec(orig);
  if (m) {
    const siteSlug = m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    netlifyPreviewPatterns.push(
      new RegExp(`^https:\\/\\/(deploy-preview-\\d+--)??${siteSlug}\\.netlify\\.app$`, 'i')
    );
  }
}

export function isOriginAllowed(
  origin: string | undefined,
  customAllowed?: Set<string>
): boolean {
  if (!origin) return true; // Same-origin or server health check
  const normalized = origin.trim().replace(/\/+$/, '');
  const activeSet = customAllowed ?? allowedOrigins;
  if (activeSet.has(normalized)) return true;
  if (
    !customAllowed &&
    NODE_ENV !== 'production' &&
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(normalized)
  ) {
    return true;
  }
  for (const re of netlifyPreviewPatterns) {
    if (re.test(normalized)) {
      return true;
    }
  }
  return false;
}

const app = express();

// Strict Origin Enforcement Middleware: returns 403 Forbidden (never 500 stack trace) on disallowed Origin
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !isOriginAllowed(origin)) {
    res.status(403).json({
      ok: false,
      error: 'FORBIDDEN_ORIGIN',
      message: 'Origin is not permitted.',
    });
    return;
  }
  next();
});

app.use(
  cors({
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
  })
);
app.use(express.json());

// Lightweight IP Rate Limiter for HTTP API endpoints (P2-2)
const apiRateMap = new Map<string, { windowStartMs: number; count: number }>();
function checkApiRateLimit(ip: string, maxPer10Sec = 30): boolean {
  const now = Date.now();
  const entry = apiRateMap.get(ip);
  if (!entry || now - entry.windowStartMs > 10_000) {
    apiRateMap.set(ip, { windowStartMs: now, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= maxPer10Sec;
}

// Health Endpoint for Render & Frontend Cold-Start Wakeup Probe (includes tickLagMsP95, rooms, uptime - P0-3)
app.get('/health', (_req, res) => {
  const uptime = Math.round(process.uptime());
  const rooms = activeRoomsByCode.size;
  res.status(200).json({
    status: 'ok',
    service: 'rift-duel-server',
    uptime,
    uptimeSeconds: uptime,
    rooms,
    activeRooms: rooms,
    tickLagMsP95: getServerTickLagP95Ms(),
    timestamp: Date.now(),
  });
});

// Room Lookup Endpoint by 6-Character Room Code
app.get('/api/rooms/:code', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkApiRateLimit(ip, 30)) {
    res.status(429).json({
      ok: false,
      error: 'RATE_LIMITED',
      message: 'Quá nhiều yêu cầu tra cứu phòng. Vui lòng thử lại sau ít giây.',
    });
    return;
  }

  const code = (req.params.code || '').trim().toUpperCase();
  const playerToken = typeof req.query.token === 'string' ? req.query.token : undefined;

  if (!code) {
    res.status(400).json({
      ok: false,
      error: 'INVALID_CODE',
      message: 'Mã phòng không hợp lệ.',
    });
    return;
  }

  const room = activeRoomsByCode.get(code);
  if (!room) {
    res.status(404).json({
      ok: false,
      error: 'ROOM_NOT_FOUND',
      message: 'Phòng không tồn tại hoặc đã hết hạn (có thể do server khởi động lại).',
    });
    return;
  }

  const info = room.getRoomStatusInfo(playerToken);
  if (!info.canJoin) {
    res.status(409).json({
      ok: false,
      error: 'ROOM_FULL',
      roomCode: info.roomCode,
      message: 'Phòng đấu đã đủ 2 người chơi.',
    });
    return;
  }

  res.status(200).json({
    ok: true,
    roomId: info.roomId,
    roomCode: info.roomCode,
    playerCount: info.playerCount,
  });
});

const httpServer = http.createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({
    server: httpServer,
    pingInterval: 2000,
    pingMaxRetries: 3,
    verifyClient: (info, next) => {
      const origin = info.origin || (info.req.headers.origin as string | undefined);
      if (isOriginAllowed(origin)) {
        next(true);
      } else {
        next(false, 403, 'Forbidden Origin');
      }
    },
  }),
});

gameServer.define('rift_room', RiftRoom);

if (process.env.VITEST !== 'true') {
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[RIFT DUEL SERVER] Listening on ws://0.0.0.0:${PORT} (env: ${NODE_ENV})`);
  });
}
