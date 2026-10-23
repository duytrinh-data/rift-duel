import http from 'http';
import express from 'express';
import cors from 'cors';
import colyseusPkg from 'colyseus';
import wsTransportPkg from '@colyseus/ws-transport';
import { RiftRoom, activeRoomsByCode } from './rooms/RiftRoom.js';

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
  .map((o) => o.trim())
  .filter(Boolean);

const allowedOrigins = new Set([...defaultOrigins, ...configuredOrigins]);

function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // Same-origin or server health check
  if (allowedOrigins.has(origin)) return true;
  if (NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return true;
  }
  // Allow configured Netlify subdomain previews if any *.netlify.app is in ALLOWED_ORIGINS
  for (const allowed of allowedOrigins) {
    if (allowed.endsWith('.netlify.app') && origin.endsWith('.netlify.app')) {
      return true;
    }
  }
  return false;
}

const app = express();
app.use(
  cors({
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      }
    },
    credentials: true,
  })
);
app.use(express.json());

// Health Endpoint for Render & Frontend Cold-Start Wakeup Probe
app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'rift-duel-server',
    uptimeSeconds: Math.round(process.uptime()),
    activeRooms: activeRoomsByCode.size,
    timestamp: Date.now(),
  });
});

// Room Lookup Endpoint by 6-Character Room Code
app.get('/api/rooms/:code', (req, res) => {
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
    pingInterval: 5000,
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

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[RIFT DUEL SERVER] Listening on ws://0.0.0.0:${PORT} (env: ${NODE_ENV})`);
});
